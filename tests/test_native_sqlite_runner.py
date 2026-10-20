"""Exercise Android collector errors without an emulator or personal data."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch, call

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


class RecoveryControllerTests(unittest.TestCase):
    DEVICE = '11111111-1111-1111-1111-111111111111'

    def report(self, status='ready_for_interruption'):
        return {
            'schemaVersion': 2, 'runId': '123', 'attempt': '1', 'platform': 'ios',
            'database': 'cv2_sqlite_audit_123_1_ios', 'databaseVersion': 3,
            'committedVersion': 2, 'transactionOpen': True, 'status': status,
            'checks': runner.CHECKS + ['process_restart', 'uncommitted_migration_prepared'],
        }

    def test_pending_report_requires_uncommitted_transaction_evidence(self):
        report = self.report()
        runner.validate(report, 'ios', '123', '1', 'ready_for_interruption')
        for changed in [{'transactionOpen': False}, {'committedVersion': 3}, {'schemaVersion': 1}]:
            with self.assertRaisesRegex(RuntimeError, 'Invalid or incomplete'):
                runner.validate({**report, **changed}, 'ios', '123', '1', 'ready_for_interruption')

    def test_previous_phase_can_remain_on_disk_until_the_next_report_arrives(self):
        previous = {**self.report(), 'status': 'ready_for_restart', 'databaseVersion': 2,
                    'transactionOpen': False, 'checks': runner.CHECKS}
        reads = iter([json.dumps(previous), json.dumps(self.report())])
        with patch.object(runner.time, 'sleep'):
            result = runner.wait_report(lambda: next(reads), 'ios', '123', '1', 'ready_for_interruption')
        self.assertEqual(result['status'], 'ready_for_interruption')

    def test_future_or_completed_phase_cannot_skip_the_interruption(self):
        with self.assertRaisesRegex(RuntimeError, 'Unexpected native probe state'):
            runner.wait_report(lambda: '{"status":"passed"}', 'ios', '123', '1', 'ready_for_interruption')

    def test_unknown_expected_phase_is_rejected_before_reading(self):
        with patch.object(runner, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'Unknown expected'):
                runner.wait_report(lambda: '', 'ios', '123', '1', 'unknown')
            command.assert_not_called()

    def test_interrupt_refuses_the_collector_process(self):
        with patch.object(runner.os, 'getpid', return_value=12345), patch.object(runner.os, 'kill') as kill:
            with self.assertRaisesRegex(RuntimeError, 'Refusing to interrupt this process'):
                runner.interrupt_ios_audit_app(self.DEVICE, '12345')
            kill.assert_not_called()

    def test_interrupt_refuses_an_unrelated_executable(self):
        with tempfile.TemporaryDirectory(prefix='cv-process-identity-') as directory:
            bundle = Path(directory) / 'App.app'
            bundle.mkdir()
            (bundle / 'App').write_text('test fixture, never executed')
            with patch.object(runner, 'command', side_effect=[reply(out=str(bundle)), reply(out='/unrelated/process')]), patch.object(runner.os, 'getpid', return_value=99), patch.object(runner.os, 'kill') as kill:
                with self.assertRaisesRegex(RuntimeError, 'unverified simulator app identity'):
                    runner.interrupt_ios_audit_app(self.DEVICE, '12345')
                kill.assert_not_called()

    def test_interrupt_targets_only_the_verified_simulator_app_then_waits_for_exit(self):
        with tempfile.TemporaryDirectory(prefix='cv-process-identity-') as directory:
            bundle = Path(directory) / 'App.app'
            bundle.mkdir()
            executable = bundle / 'App'
            executable.write_text('test fixture, never executed')
            with patch.object(runner, 'command', side_effect=[reply(out=str(bundle)), reply(out=str(executable))]), patch.object(runner.os, 'getpid', return_value=99), patch.object(runner.os, 'kill', side_effect=[None, ProcessLookupError]) as kill:
                runner.interrupt_ios_audit_app(self.DEVICE, '12345')
            self.assertEqual(kill.call_args_list, [call(12345, runner.signal.SIGKILL), call(12345, 0)])


if __name__ == '__main__':
    unittest.main()
