"""Verify supervisor failure handling without starting or stopping an emulator."""
import importlib.util
import io
import os
from pathlib import Path
import subprocess
import unittest
from contextlib import redirect_stdout
from unittest.mock import Mock, patch

source = Path(__file__).resolve().parents[1] / 'scripts/run-android-sqlite-emulator.py'
spec = importlib.util.spec_from_file_location('native_emulator_supervisor', source)
supervisor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(supervisor)


def process(code=None):
    child = Mock()
    child.pid = os.getpid() + 1
    child.poll.return_value = code
    return child


def reply(code=0, text=''):
    return subprocess.CompletedProcess([], code, text, '')


class EmulatorSupervisorTests(unittest.TestCase):
    def test_non_ci_environment_is_refused_before_commands(self):
        with patch.dict(os.environ, {'GITHUB_ACTIONS': 'false'}), patch.object(supervisor, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'restricted'):
                supervisor.main()
            command.assert_not_called()

    def test_invalid_ci_identity_is_refused(self):
        with patch.object(supervisor.sys, 'platform', 'linux'):
            with self.assertRaisesRegex(RuntimeError, 'Invalid CI identity'):
                supervisor.ci_context({'GITHUB_ACTIONS': 'true', 'GITHUB_RUN_ID': '../x', 'GITHUB_RUN_ATTEMPT': '1'})

    def test_existing_physical_or_virtual_devices_are_refused(self):
        supervisor.require_no_devices('List of devices attached\n\n')
        for line in ('physical-device\tdevice', 'emulator-5554\toffline', 'emulator-5556\tdevice'):
            with self.assertRaisesRegex(RuntimeError, 'existing Android devices'):
                supervisor.require_no_devices('List of devices attached\n' + line + '\n')

    def test_emulator_signal_is_preserved_before_any_boot_command(self):
        with patch.object(supervisor, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'SIGSEGV'):
                supervisor.wait_for_boot(process(-11), {})
            command.assert_not_called()

    def test_boot_waits_for_package_manager_in_addition_to_the_boot_flag(self):
        with patch.object(supervisor, 'command', side_effect=[
            reply(text='1\n'), reply(1), reply(text='1\n'), reply(text='package:/system/framework/framework-res.apk\n'),
        ]) as command, patch.object(supervisor.time, 'sleep') as sleep:
            supervisor.wait_for_boot(process(), {})
        self.assertEqual(command.call_count, 4)
        sleep.assert_called_once_with(2)

    def test_probe_success_cannot_hide_emulator_exit(self):
        child = process()
        child.poll.side_effect = [None, -9, -9]
        with patch.object(supervisor.subprocess, 'run', return_value=reply()), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'SIGKILL'):
                supervisor.run_probe(child, {})

    def test_probe_failure_is_preserved_when_emulator_remains_alive(self):
        with patch.object(supervisor.subprocess, 'run', return_value=reply(1)), redirect_stdout(io.StringIO()):
            with self.assertRaisesRegex(RuntimeError, 'SQLite probe exited 1; emulator still running'):
                supervisor.run_probe(process(), {})

    def test_cleanup_does_not_signal_an_already_exited_child(self):
        child = process(-11)
        supervisor.stop_owned(child)
        child.terminate.assert_not_called()
        child.kill.assert_not_called()

    def test_cleanup_refuses_the_current_process(self):
        child = process()
        child.pid = os.getpid()
        with self.assertRaisesRegex(RuntimeError, 'Refusing'):
            supervisor.stop_owned(child)
        child.terminate.assert_not_called()

    def test_cleanup_waits_before_force_stopping_its_owned_child(self):
        child = process()
        child.wait.side_effect = [subprocess.TimeoutExpired('owned', 10), None]
        supervisor.stop_owned(child)
        child.terminate.assert_called_once_with()
        child.kill.assert_called_once_with()
        self.assertEqual(child.wait.call_count, 2)


if __name__ == '__main__':
    unittest.main()
