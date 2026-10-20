"""Run the generated CI-only CineVault probe on a fresh emulator/simulator."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time

APP = 'com.cinevault.pessoal'
RESULT = 'cv2-native-sqlite-result.json'
CHECKS = [
    'parameterized_unicode_crud', 'explicit_commit', 'explicit_rollback',
    'failed_batch_atomicity', 'migration_v1_v2', 'connection_reopen',
]


def command(args, *, check=True, timeout=90):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(args) + '\n' + result.stderr[-4000:])
    return result


def validate(report, platform, run_id, attempt, status):
    expected = {
        'schemaVersion': 1, 'runId': run_id, 'attempt': attempt,
        'platform': platform,
        'database': f'cv2_sqlite_audit_{run_id}_{attempt}_{platform}',
        'databaseVersion': 2, 'status': status,
        'checks': CHECKS + (['process_restart'] if status == 'passed' else []),
    }
    if any(report.get(key) != value for key, value in expected.items()):
        raise RuntimeError('Invalid or incomplete native report: ' + json.dumps(report))


def wait_report(read, platform, run_id, attempt, status):
    deadline = time.monotonic() + 120
    last = 'result not available'
    while time.monotonic() < deadline:
        raw = read()
        if raw:
            try:
                report = json.loads(raw)
            except json.JSONDecodeError:
                last = 'result write still incomplete'
            else:
                if not isinstance(report, dict):
                    raise RuntimeError('Native report is not an object')
                if report.get('status') == 'failed':
                    raise RuntimeError('Native probe failed: ' + json.dumps(report))
                if report.get('status') == status:
                    validate(report, platform, run_id, attempt, status)
                    return report
                # Phase-one output remains on disk until phase two writes its result.
                if status == 'passed' and report.get('status') == 'ready_for_restart':
                    validate(report, platform, run_id, attempt, 'ready_for_restart')
                    last = 'waiting for process restart verification'
                else:
                    raise RuntimeError('Unexpected native probe state: ' + json.dumps(report))
        time.sleep(1)
    raise TimeoutError('Native probe timed out: ' + last)


def android(run_id, attempt):
    devices = command(['adb', 'devices']).stdout.splitlines()[1:]
    active = [line.split()[0] for line in devices if len(line.split()) == 2 and line.split()[1] == 'device']
    if len(active) != 1 or not active[0].startswith('emulator-'):
        raise RuntimeError('Exactly one CI emulator is required; physical devices are refused')
    prefix = ['adb', '-s', active[0]]
    if command(prefix + ['shell', 'pm', 'path', APP], check=False).stdout.strip():
        raise RuntimeError('Fresh emulator required: CineVault is already installed')
    apk = 'android/app/build/outputs/apk/debug/app-debug.apk'
    command(prefix + ['install', apk])

    def launch():
        command(prefix + ['shell', 'am', 'start', '-W', '-n', APP + '/.MainActivity'])

    def read():
        return command(prefix + ['shell', 'run-as', APP, 'cat', 'cache/' + RESULT], check=False).stdout

    launch()
    first = wait_report(read, 'android', run_id, attempt, 'ready_for_restart')
    pid_before = command(prefix + ['shell', 'pidof', APP]).stdout.strip()
    command(prefix + ['shell', 'am', 'force-stop', APP])
    if command(prefix + ['shell', 'pidof', APP], check=False).stdout.strip():
        raise RuntimeError('Android process did not stop')
    launch()
    report = wait_report(read, 'android', run_id, attempt, 'passed')
    pid_after = command(prefix + ['shell', 'pidof', APP]).stdout.strip()
    if not pid_before or not pid_after or pid_before == pid_after:
        raise RuntimeError('Could not verify a new Android process')
    return {**report, 'processRestart': {'before': pid_before, 'after': pid_after}, 'phaseOne': first['status']}


def ios(run_id, attempt):
    runtimes = json.loads(command(['xcrun', 'simctl', 'list', 'runtimes', '-j']).stdout)['runtimes']
    runtime = next((item['identifier'] for item in runtimes if item.get('isAvailable') and item['identifier'].endswith('.iOS-26-2')), None)
    if not runtime:
        raise RuntimeError('The configured iOS 26.2 simulator runtime is unavailable')
    device = command(['xcrun', 'simctl', 'create', 'CineVault-SQLite-Audit', 'com.apple.CoreSimulator.SimDeviceType.iPhone-17', runtime]).stdout.strip()
    if not re.fullmatch(r'[0-9A-Fa-f-]{36}', device):
        raise RuntimeError('Unexpected simulator identifier')
    command(['xcrun', 'simctl', 'boot', device])
    command(['xcrun', 'simctl', 'bootstatus', device, '-b'], timeout=240)
    app = Path(os.environ['RUNNER_TEMP']) / 'cinevault-ios/Build/Products/Debug-iphonesimulator/App.app'
    command(['xcrun', 'simctl', 'install', device, str(app)])
    container = Path(command(['xcrun', 'simctl', 'get_app_container', device, APP, 'data']).stdout.strip())
    result = container / 'Library/Caches' / RESULT

    def read():
        return result.read_text(encoding='utf-8') if result.is_file() else ''

    def launch():
        output = command(['xcrun', 'simctl', 'launch', device, APP]).stdout.strip()
        match = re.fullmatch(re.escape(APP) + r': (\d+)', output)
        if not match:
            raise RuntimeError('Unexpected simulator launch output: ' + output)
        return match.group(1)

    pid_before = launch()
    first = wait_report(read, 'ios', run_id, attempt, 'ready_for_restart')
    command(['xcrun', 'simctl', 'terminate', device, APP])
    pid_after = launch()
    report = wait_report(read, 'ios', run_id, attempt, 'passed')
    if pid_before == pid_after:
        raise RuntimeError('Could not verify a new iOS process')
    return {**report, 'processRestart': {'before': pid_before, 'after': pid_after}, 'phaseOne': first['status']}


def main():
    if os.environ.get('GITHUB_ACTIONS') != 'true' or not os.environ.get('RUNNER_TEMP'):
        raise RuntimeError('This runner is restricted to GitHub Actions')
    run_id = os.environ.get('GITHUB_RUN_ID', '')
    attempt = os.environ.get('GITHUB_RUN_ATTEMPT', '')
    if not re.fullmatch(r'[1-9]\d{0,19}', run_id) or not re.fullmatch(r'[1-9]\d{0,5}', attempt):
        raise RuntimeError('Invalid CI identity')
    platform = sys.argv[1] if len(sys.argv) == 2 else ''
    if platform not in ('android', 'ios'):
        raise RuntimeError('Expected android or ios')
    report = (android if platform == 'android' else ios)(run_id, attempt)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
