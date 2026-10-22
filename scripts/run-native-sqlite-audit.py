"""Run the generated CI-only CineVault probe on a fresh emulator/simulator."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import time

APP = 'com.cinevault.pessoal'
RESULT = 'cv2-native-sqlite-result.json'
CHECKS = [
    'parameterized_unicode_crud', 'explicit_commit', 'explicit_rollback',
    'failed_batch_atomicity', 'migration_v1_v2', 'connection_reopen', 'raw_snapshot_exact_round_trip',
]


def command(args, *, check=True, timeout=90):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if check and result.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(args) + '\n' + result.stderr[-4000:])
    return result


def validate(report, platform, run_id, attempt, status):
    phases = {
        'ready_for_restart': (2, 2, False, CHECKS),
        'ready_for_interruption': (3, 2, True, CHECKS + ['process_restart', 'raw_snapshot_process_restart',
                                                    'uncommitted_migration_prepared', 'uncommitted_raw_snapshot_modified']),
        'passed': (3, 3, False, CHECKS + ['process_restart', 'raw_snapshot_process_restart',
                                      'interrupted_migration_rollback', 'migration_retry_committed', 'raw_snapshot_interruption_recovery']),
    }
    if status not in phases:
        raise RuntimeError('Unknown native audit phase')
    version, committed, transaction_open, checks = phases[status]
    expected = {
        'schemaVersion': 3, 'runId': run_id, 'attempt': attempt,
        'platform': platform,
        'database': f'cv2_sqlite_audit_{run_id}_{attempt}_{platform}',
        'databaseVersion': version, 'committedVersion': committed,
        'transactionOpen': transaction_open, 'status': status, 'checks': checks,
    }
    if any(report.get(key) != value for key, value in expected.items()):
        raise RuntimeError('Invalid or incomplete native report: ' + json.dumps(report))


def wait_report(read, platform, run_id, attempt, status):
    phases = ['ready_for_restart', 'ready_for_interruption', 'passed']
    if status not in phases:
        raise RuntimeError('Unknown expected native audit phase')
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
                # Earlier output remains on disk while the next launch runs.
                phase = report.get('status')
                if phase in phases and phases.index(phase) < phases.index(status):
                    validate(report, platform, run_id, attempt, phase)
                    last = 'waiting for ' + status
                else:
                    raise RuntimeError('Unexpected native probe state: ' + json.dumps(report))
        time.sleep(1)
    raise TimeoutError('Native probe timed out: ' + last)


def launch_android(prefix):
    output = command(prefix + ['shell', 'am', 'start', '-W', '-n', APP + '/.MainActivity']).stdout
    print('Android launch:\n' + output.strip(), flush=True)
    if not re.search(r'^Status:\s*ok\s*$', output, re.MULTILINE):
        raise RuntimeError('Android did not confirm a successful activity launch: ' + output.strip())


def read_android_report(prefix):
    reply = command(prefix + ['shell', 'run-as', APP, 'cat', 'cache/' + RESULT], check=False)
    if reply.returncode == 0:
        return reply.stdout
    detail = (reply.stderr + '\n' + reply.stdout).strip()
    state = command(prefix + ['get-state'], check=False)
    if state.returncode or state.stdout.strip() != 'device':
        raise RuntimeError('Android emulator disconnected while waiting for the report: ' +
                           (state.stderr + '\n' + state.stdout).strip())
    if 'no such file or directory' not in detail.lower():
        raise RuntimeError('Cannot read the Android audit report: ' + detail)
    pid = command(prefix + ['shell', 'pidof', APP], check=False)
    if pid.returncode or not pid.stdout.strip():
        raise RuntimeError('CineVault process exited before producing the audit report')
    return ''


def relevant_android_log(text):
    pattern = re.compile(r'CINEVAULT_SQLITE_AUDIT|Capacitor|chromium|AndroidRuntime|FATAL|'
                         r'lowmemorykiller|lmkd|am_crash|am_kill|ActivityTaskManager|'
                         r'com\.cinevault\.pessoal|signal [0-9]+', re.IGNORECASE)
    return '\n'.join(line for line in text.splitlines() if pattern.search(line))[-18000:]


def android_diagnostics(prefix, log_path):
    print('\n=== ANDROID RUNTIME DIAGNOSTICS ===', flush=True)
    for args in [prefix + ['get-state'], prefix + ['shell', 'pidof', APP], ['free', '-m'],
                 ['df', '-m', os.environ.get('RUNNER_TEMP', '/tmp')]]:
        try:
            reply = command(args, check=False, timeout=10)
            print(' '.join(args) + '\n' + (reply.stdout + reply.stderr)[-2500:], flush=True)
        except Exception as error:
            print('Diagnostic command unavailable: ' + str(error), flush=True)
    try:
        reply = command(['ps', '-eo', 'pid,ppid,stat,comm'], check=False, timeout=10)
        if reply.returncode == 0:
            processes = [line for line in reply.stdout.splitlines()
                         if re.search(r'\b(qemu\S*|emulator\S*|crashpad\S*|adb)\s*$', line)]
            print('Host emulator processes (PID PPID STAT COMMAND):\n' +
                  ('\n'.join(processes)[-4000:] or '(none found)'), flush=True)
        else:
            print('Host process diagnostics unavailable: ' + reply.stderr[-500:], flush=True)
    except Exception as error:
        print('Host process diagnostics unavailable: ' + str(error), flush=True)
    try:
        text = log_path.read_text(encoding='utf-8', errors='replace')
        print('Filtered emulator logcat:\n' + relevant_android_log(text), flush=True)
    except Exception as error:
        print('Logcat unavailable: ' + str(error), flush=True)
    try:
        reply = command(['sudo', '-n', 'dmesg', '--ctime'], check=False, timeout=10)
        if reply.returncode == 0:
            memory = [line for line in reply.stdout.splitlines() if re.search(
                r'out of memory|oom-kill|killed process|qemu.*segfault|segfault.*qemu', line, re.IGNORECASE)]
            print('Host memory/crash events:\n' + '\n'.join(memory[-20:])[-6000:], flush=True)
        else:
            print('Host kernel diagnostics unavailable: ' + reply.stderr[-500:], flush=True)
    except Exception as error:
        print('Host kernel diagnostics unavailable: ' + str(error), flush=True)


def android(run_id, attempt):
    devices = command(['adb', 'devices']).stdout.splitlines()[1:]
    active = [line.split()[0] for line in devices if len(line.split()) == 2 and line.split()[1] == 'device']
    if len(active) != 1 or not active[0].startswith('emulator-'):
        raise RuntimeError('Exactly one CI emulator is required; physical devices are refused')
    prefix = ['adb', '-s', active[0]]
    if command(prefix + ['shell', 'pm', 'path', APP], check=False).stdout.strip():
        raise RuntimeError('Fresh emulator required: CineVault is already installed')
    log_path = Path(os.environ['RUNNER_TEMP']) / 'cinevault-android-logcat.txt'
    with log_path.open('w', encoding='utf-8') as log_file:
        collector = subprocess.Popen(prefix + ['logcat', '-v', 'threadtime'], stdout=log_file, stderr=subprocess.STDOUT)
        try:
            apk = 'android/app/build/outputs/apk/debug/app-debug.apk'
            command(prefix + ['install', apk])
            read = lambda: read_android_report(prefix)
            launch_android(prefix)
            first = wait_report(read, 'android', run_id, attempt, 'ready_for_restart')
            print('SQLite phase one passed; checking process restart.', flush=True)
            pid_before = command(prefix + ['shell', 'pidof', APP]).stdout.strip()
            command(prefix + ['shell', 'am', 'force-stop', APP])
            if command(prefix + ['shell', 'pidof', APP], check=False).stdout.strip():
                raise RuntimeError('Android process did not stop')
            launch_android(prefix)
            pending = wait_report(read, 'android', run_id, attempt, 'ready_for_interruption')
            pid_pending = command(prefix + ['shell', 'pidof', APP]).stdout.strip()
            print('Uncommitted schema and record writes prepared; force-stopping only the audit app.', flush=True)
            command(prefix + ['shell', 'am', 'force-stop', APP])
            if command(prefix + ['shell', 'pidof', APP], check=False).stdout.strip():
                raise RuntimeError('Android process did not stop during the interruption test')
            launch_android(prefix)
            report = wait_report(read, 'android', run_id, attempt, 'passed')
            pid_after = command(prefix + ['shell', 'pidof', APP]).stdout.strip()
            pids = [pid_before, pid_pending, pid_after]
            if any(not re.fullmatch(r'[1-9]\d*', pid) for pid in pids) or len(set(pids)) != 3:
                raise RuntimeError('Could not verify three distinct Android processes')
            return {**report, 'processRestart': {'before': pid_before, 'after': pid_pending},
                    'forcedInterruption': {'before': pid_pending, 'after': pid_after,
                                           'method': 'am_force_stop', 'transactionOpenConfirmed': pending['transactionOpen']},
                    'phaseOne': first['status']}
        except Exception:
            android_diagnostics(prefix, log_path)
            raise
        finally:
            if collector.poll() is None:
                collector.terminate()
                try:
                    collector.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    collector.kill()
                    collector.wait(timeout=5)


def interrupt_ios_audit_app(device, pid):
    # Only the process returned by simctl for this fresh audit application's
    # installed executable may be killed. Refuse unrelated PIDs and paths.
    if not re.fullmatch(r'[0-9A-Fa-f-]{36}', device) or not re.fullmatch(r'[1-9]\d*', pid):
        raise RuntimeError('Invalid simulator or process identity')
    number = int(pid)
    if number <= 1 or number == os.getpid():
        raise RuntimeError('Refusing to interrupt this process')
    bundle = Path(command(['xcrun', 'simctl', 'get_app_container', device, APP, 'app']).stdout.strip()).resolve()
    expected = bundle / 'App'
    actual = command(['ps', '-ww', '-p', pid, '-o', 'comm=']).stdout.strip()
    if bundle.name != 'App.app' or not expected.is_file() or Path(actual).resolve() != expected.resolve():
        raise RuntimeError('Refusing to kill a process with unverified simulator app identity')
    os.kill(number, signal.SIGKILL)
    deadline = time.monotonic() + 15
    while time.monotonic() < deadline:
        try:
            os.kill(number, 0)
        except ProcessLookupError:
            return
        time.sleep(0.1)
    raise TimeoutError('The verified simulator app process did not exit')


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
    pid_pending = launch()
    pending = wait_report(read, 'ios', run_id, attempt, 'ready_for_interruption')
    print('Uncommitted schema and record writes prepared; interrupting verified simulator app.', flush=True)
    interrupt_ios_audit_app(device, pid_pending)
    pid_after = launch()
    report = wait_report(read, 'ios', run_id, attempt, 'passed')
    if len({pid_before, pid_pending, pid_after}) != 3:
        raise RuntimeError('Could not verify three distinct iOS processes')
    return {**report, 'processRestart': {'before': pid_before, 'after': pid_pending},
            'forcedInterruption': {'before': pid_pending, 'after': pid_after,
                                   'method': 'SIGKILL_verified_simulator_app', 'transactionOpenConfirmed': pending['transactionOpen']},
            'phaseOne': first['status']}


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
