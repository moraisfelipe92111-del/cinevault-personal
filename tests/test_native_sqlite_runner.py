"""Exercise Android collector errors without an emulator or personal data."""
import importlib.util
import io
from pathlib import Path
import subprocess
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

source = Path(__file__).resolve().parents[1] / 'scripts/run-native-sqlite-audit.py'
spec = importlib.util.spec_from_file_location('native_sqlite_runner', source)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)
PREFIX = ['adb', '-s', 'emulator-5554']


def reply(code=0, out='', error=''):
    return subprocess.CompletedProcess([], code, out, error)


class AndroidCollectorTests(unittest.TestCase):
    def test_available_result_is_returned(self):
        with patch.object(runner, 'command', return_value=reply(out='{"status":"passed"}')) as command:
            self.assertEqual(runner.read_android_report(PREFIX), '{"status":"passed"}')
            self.assertEqual(command.call_count, 1)

    def test_missing_file_is_pending_only_with_live_emulator_and_app(self):
        with patch.object(runner, 'command', side_effect=[
            reply(1, error='cat: cache/report: No such file or directory'),
            reply(out='device\n'), reply(out='1234\n'),
        ]):
            self.assertEqual(runner.read_android_report(PREFIX), '')

    def test_transport_failure_is_not_silently_treated_as_pending(self):
        with patch.object(runner, 'command', side_effect=[
            reply(1, error='error: device offline'), reply(1, error='device offline'),
        ]):
            with self.assertRaisesRegex(RuntimeError, 'emulator disconnected'):
                runner.read_android_report(PREFIX)

    def test_permissions_failure_is_preserved(self):
        with patch.object(runner, 'command', side_effect=[
            reply(1, error='run-as: package not debuggable'), reply(out='device\n'),
        ]):
            with self.assertRaisesRegex(RuntimeError, 'package not debuggable'):
                runner.read_android_report(PREFIX)

    def test_exited_app_is_reported_without_waiting_for_timeout(self):
        with patch.object(runner, 'command', side_effect=[
            reply(1, error='cat: report: No such file or directory'),
            reply(out='device\n'), reply(1),
        ]):
            with self.assertRaisesRegex(RuntimeError, 'process exited'):
                runner.read_android_report(PREFIX)

    def test_successful_activity_launch_is_checked(self):
        with patch.object(runner, 'command', return_value=reply(out='Starting: Intent\nStatus: ok\nTotalTime: 850\n')):
            with redirect_stdout(io.StringIO()):
                runner.launch_android(PREFIX)

    def test_zero_exit_code_does_not_hide_an_activity_launch_error(self):
        with patch.object(runner, 'command', return_value=reply(out='Error type 3\nError: Activity class does not exist.\n')):
            with redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'successful activity launch'):
                    runner.launch_android(PREFIX)

    def test_log_filter_retains_app_and_crash_errors_with_bounded_output(self):
        text = 'UnrelatedTag unrelated message\n' + '\n'.join(
            'Capacitor/Console CINEVAULT_SQLITE_AUDIT probe error ' + str(i) for i in range(1000)
        ) + '\nAndroidRuntime FATAL EXCEPTION: main'
        filtered = runner.relevant_android_log(text)
        self.assertLessEqual(len(filtered), 18000)
        self.assertNotIn('UnrelatedTag', filtered)
        self.assertIn('probe error 999', filtered)
        self.assertIn('FATAL EXCEPTION', filtered)


if __name__ == '__main__':
    unittest.main()
