"""Own one fresh CI emulator and preserve its exit status for the SQLite audit."""
import json
import os
from pathlib import Path
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time

SERIAL = 'emulator-5554'
IMAGE = 'system-images;android-36;google_apis;x86_64'
RAM_MB = 4096


def ci_context(environment):
    if environment.get('GITHUB_ACTIONS') != 'true' or sys.platform != 'linux':
        raise RuntimeError('The emulator supervisor is restricted to Linux GitHub Actions')
    run_id = environment.get('GITHUB_RUN_ID', '')
    attempt = environment.get('GITHUB_RUN_ATTEMPT', '')
    if not re.fullmatch(r'[1-9]\d{0,19}', run_id) or not re.fullmatch(r'[1-9]\d{0,5}', attempt):
        raise RuntimeError('Invalid CI identity')
    temporary = Path(environment.get('RUNNER_TEMP', ''))
    sdk = Path(environment.get('ANDROID_HOME', ''))
    if not temporary.is_absolute() or not temporary.is_dir() or not sdk.is_absolute() or not sdk.is_dir():
        raise RuntimeError('Absolute runner temporary and Android SDK directories are required')
    return temporary, sdk, run_id, attempt


def command(args, environment, *, check=True, timeout=90, data=None):
    reply = subprocess.run(args, env=environment, input=data, capture_output=True, text=True, timeout=timeout)
    if check and reply.returncode:
        raise RuntimeError('Command failed: ' + ' '.join(map(str, args)) + '\n' +
                           (reply.stdout + reply.stderr)[-4000:])
    return reply


def require_no_devices(output):
    devices = [line.strip() for line in output.splitlines()
               if line.strip() and not line.startswith('List of devices attached')]
    if devices:
        raise RuntimeError('Fresh CI host required; existing Android devices are refused')


def require_free_ports():
    for port in (5554, 5555):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
            try:
                connection.bind(('127.0.0.1', port))
            except OSError as error:
                raise RuntimeError('Emulator port already occupied: ' + str(port)) from error


def exit_description(code):
    if code is None:
        return 'still running'
    if code < 0:
        try:
            return 'signal ' + signal.Signals(-code).name + ' (' + str(code) + ')'
        except ValueError:
            pass
    return 'exit code ' + str(code)


def require_running(child):
    code = child.poll()
    if code is not None:
        raise RuntimeError('Owned Android emulator ended unexpectedly: ' + exit_description(code))


def wait_for_boot(child, environment):
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        require_running(child)
        boot = command(['adb', '-s', SERIAL, 'shell', 'getprop', 'sys.boot_completed'],
                       environment, check=False, timeout=15)
        if boot.returncode == 0 and boot.stdout.strip() == '1':
            packages = command(['adb', '-s', SERIAL, 'shell', 'pm', 'path', 'android'],
                               environment, check=False, timeout=15)
            if packages.returncode == 0 and packages.stdout.strip().startswith('package:'):
                require_running(child)
                return
        time.sleep(2)
    raise TimeoutError('Owned Android emulator did not finish booting in 300 seconds')


def stop_owned(child):
    # This function receives only a Popen created by this supervisor, never a PID
    # read from adb, ps, a file, or another process.
    if child.poll() is not None:
        return
    if child.pid <= 1 or child.pid == os.getpid():
        raise RuntimeError('Refusing to stop an invalid owned process')
    child.terminate()
    try:
        child.wait(timeout=10)
    except subprocess.TimeoutExpired:
        child.kill()
        child.wait(timeout=10)


def run_probe(child, environment):
    require_running(child)
    reply = subprocess.run([sys.executable, '-u', 'scripts/run-native-sqlite-audit.py', 'android'],
                           env=environment, timeout=600)
    code = child.poll()
    print('Emulator status before cleanup: ' + exit_description(code), flush=True)
    if reply.returncode:
        raise RuntimeError('SQLite probe exited ' + str(reply.returncode) +
                           '; emulator ' + exit_description(code))
    require_running(child)


def host_memory(label):
    print('=== HOST MEMORY ' + label + ' ===', flush=True)
    try:
        rows = Path('/proc/meminfo').read_text().splitlines()
        print('\n'.join(row for row in rows if row.split(':')[0] in
                        {'MemTotal', 'MemAvailable', 'SwapTotal', 'SwapFree'}), flush=True)
        for name in ('memory.events', 'memory.max', 'memory.current', 'memory.peak'):
            path = Path('/sys/fs/cgroup') / name
            if path.is_file():
                print(name + ': ' + path.read_text()[:2000].strip(), flush=True)
    except Exception as error:
        print('Host memory snapshot unavailable: ' + str(error), flush=True)


def log_tail(path):
    try:
        with path.open('rb') as handle:
            handle.seek(0, os.SEEK_END)
            handle.seek(max(0, handle.tell() - 24000))
            output = handle.read().decode('utf-8', errors='replace')
        # The disposable emulator's ADB public key adds no useful diagnostics.
        print('=== EMULATOR OUTPUT ===\n' + '\n'.join(
            line for line in output.splitlines() if 'adb.pubkey' not in line), flush=True)
    except Exception as error:
        print('Emulator output unavailable: ' + str(error), flush=True)


def main():
    temporary, sdk, run_id, attempt = ci_context(os.environ)
    environment = dict(os.environ)
    environment['PATH'] = str(sdk / 'platform-tools') + os.pathsep + environment.get('PATH', '')
    require_no_devices(command(['adb', 'devices'], environment).stdout)
    require_free_ports()
    work = Path(tempfile.mkdtemp(prefix='cv2-emulator-' + run_id + '-' + attempt + '-', dir=temporary))
    user = work / 'android-user'
    avds = work / 'avd'
    user.mkdir()
    avds.mkdir()
    environment.update(ANDROID_USER_HOME=str(user), ANDROID_EMULATOR_HOME=str(user),
                       ANDROID_AVD_HOME=str(avds), ANDROID_SERIAL=SERIAL)
    tools = sdk / 'cmdline-tools/latest/bin'
    command([str(tools / 'sdkmanager'), '--install', 'emulator', IMAGE, '--channel=0'],
            environment, timeout=600)
    avd = 'cv2_audit_' + run_id + '_' + attempt
    command([str(tools / 'avdmanager'), 'create', 'avd', '--name', avd,
             '--package', IMAGE, '--device', 'pixel_2'], environment, data='no\n', timeout=180)
    emulator = sdk / 'emulator/emulator'
    print(command([str(emulator), '-version'], environment).stdout.strip(), flush=True)
    command([str(emulator), '-accel-check'], environment)
    args = [str(emulator), '-avd', avd, '-port', '5554', '-memory', str(RAM_MB),
            '-cores', '2', '-no-window', '-gpu', 'swiftshader', '-feature', '-Vulkan',
            '-no-snapshot', '-noaudio', '-no-boot-anim']
    print('Owned emulator: ' + ' '.join(args), flush=True)
    host_memory('BEFORE EMULATOR')
    output = work / 'emulator-output.txt'
    child = None
    primary_error = None
    with output.open('wb') as handle:
        try:
            child = subprocess.Popen(args, env=environment, stdout=handle,
                                     stderr=subprocess.STDOUT, start_new_session=True)
            print('Owned emulator PID: ' + str(child.pid), flush=True)
            wait_for_boot(child, environment)
            command(['adb', '-s', SERIAL, 'shell', 'input', 'keyevent', '82'], environment)
            for setting in ('window_animation_scale', 'transition_animation_scale', 'animator_duration_scale'):
                command(['adb', '-s', SERIAL, 'shell', 'settings', 'put', 'global', setting, '0.0'], environment)
            print('Guest memory before the probe:\n' + command(
                ['adb', '-s', SERIAL, 'shell', 'cat', '/proc/meminfo'], environment).stdout, flush=True)
            run_probe(child, environment)
            print(json.dumps({'emulatorSupervisor': 'passed', 'ramMb': RAM_MB,
                              'ownedPid': child.pid, 'emulatorAliveBeforeCleanup': True}), flush=True)
        except Exception as error:
            primary_error = error
            if child is not None:
                print('Owned emulator failure status: ' + exit_description(child.poll()), flush=True)
            host_memory('ON FAILURE')
            log_tail(output)
            raise
        finally:
            if child is not None:
                try:
                    stop_owned(child)
                except Exception as cleanup_error:
                    if primary_error is None:
                        raise
                    print('Secondary emulator cleanup error: ' + str(cleanup_error), flush=True)


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
