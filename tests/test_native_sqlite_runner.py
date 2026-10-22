"""Exercise Android collector errors without an emulator or personal data."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch, call, Mock

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
        migration = runner.CHECKS + ['process_restart', 'raw_snapshot_process_restart',
                                    'interrupted_migration_rollback', 'migration_retry_committed', 'raw_snapshot_interruption_recovery',
                                    'personal_migration_interruption_rollback', 'personal_migration_atomic_commit', 'personal_migration_connection_reopen']
        writes = ['personal_write_atomic_batch', 'personal_write_noop', 'personal_write_stale_revision_rejected',
                  'personal_write_connection_reopen', 'personal_write_process_restart',
                  'personal_write_interruption_rollback', 'personal_write_retry_committed']
        phases = {
            'ready_for_restart': (2, 2, False, None, None, runner.CHECKS),
            'ready_for_interruption': (3, 2, True, 0, None, runner.CHECKS + ['process_restart', 'raw_snapshot_process_restart',
                                                                         'uncommitted_migration_prepared', 'uncommitted_raw_snapshot_modified',
                                                                         'uncommitted_personal_migration_prepared']),
            'ready_for_write_restart': (3, 3, False, 1, 1, migration + writes[:4]),
            'ready_for_write_interruption': (3, 3, True, 2, 1, migration + writes[:5] + ['uncommitted_personal_write_prepared']),
            'passed': (3, 3, False, 2, 2, migration + writes),
        }
        version, committed, active, revision, committed_revision, checks = phases[status]
        return {'schemaVersion': 5, 'runId': '123', 'attempt': '1', 'platform': 'ios',
                'database': 'cv2_sqlite_audit_123_1_ios', 'databaseVersion': version,
                'committedVersion': committed, 'transactionOpen': active, 'personalRevision': revision,
                'committedPersonalRevision': committed_revision, 'status': status, 'checks': checks}

    def test_pending_report_requires_uncommitted_transaction_evidence(self):
        report = self.report()
        runner.validate(report, 'ios', '123', '1', 'ready_for_interruption')
        for changed in [{'transactionOpen': False}, {'committedVersion': 3}, {'schemaVersion': 1}]:
            with self.assertRaisesRegex(RuntimeError, 'Invalid or incomplete'):
                runner.validate({**report, **changed}, 'ios', '123', '1', 'ready_for_interruption')

    def test_old_protocol_or_missing_raw_snapshot_checks_cannot_authorize_interruption(self):
        report = self.report()
        for changed in [
            {'schemaVersion': 2},
            {'schemaVersion': 3},
            {'schemaVersion': 4},
            {'checks': [check for check in report['checks'] if check != 'uncommitted_raw_snapshot_modified']},
            {'checks': [check for check in report['checks'] if check != 'raw_snapshot_process_restart']},
            {'checks': [check for check in report['checks'] if check != 'uncommitted_personal_migration_prepared']},
        ]:
            with self.assertRaisesRegex(RuntimeError, 'Invalid or incomplete'):
                runner.validate({**report, **changed}, 'ios', '123', '1', 'ready_for_interruption')

    def test_final_report_requires_personal_migration_rollback_commit_and_reopen(self):
        report = self.report('passed')
        checks = report['checks']
        runner.validate(report, 'ios', '123', '1', 'passed')
        for missing in checks[-10:]:
            with self.assertRaisesRegex(RuntimeError, 'Invalid or incomplete'):
                runner.validate({**report, 'checks': [check for check in checks if check != missing]}, 'ios', '123', '1', 'passed')

    def test_previous_phase_can_remain_on_disk_until_the_next_report_arrives(self):
        previous = self.report('ready_for_restart')
        reads = iter([json.dumps(previous), json.dumps(self.report())])
        with patch.object(runner.time, 'sleep'):
            result = runner.wait_report(lambda: next(reads), 'ios', '123', '1', 'ready_for_interruption')
        self.assertEqual(result['status'], 'ready_for_interruption')

    def test_write_interruption_requires_the_new_uncommitted_revision_and_prior_committed_revision(self):
        report = self.report('ready_for_write_interruption')
        runner.validate(report, 'ios', '123', '1', report['status'])
        for change in [{'transactionOpen': False}, {'personalRevision': 1}, {'committedPersonalRevision': 2},
                       {'personalRevision': True}, {'committedPersonalRevision': True}, {'schemaVersion': 4},
                       {'checks': [check for check in report['checks'] if check != 'uncommitted_personal_write_prepared']}]:
            with self.assertRaisesRegex(RuntimeError, 'Invalid or incomplete'):
                runner.validate({**report, **change}, 'ios', '123', '1', report['status'])
        for missing in ['personalRevision', 'committedPersonalRevision']:
            incomplete = dict(report)
            del incomplete[missing]
            with self.assertRaisesRegex(RuntimeError, 'Invalid or incomplete'):
                runner.validate(incomplete, 'ios', '123', '1', report['status'])

    def test_old_write_phase_can_remain_on_disk_but_cannot_skip_the_next_interruption(self):
        previous, pending = self.report('ready_for_write_restart'), self.report('ready_for_write_interruption')
        reads = iter(map(json.dumps, [previous, pending]))
        with patch.object(runner.time, 'sleep'):
            self.assertEqual(runner.wait_report(lambda: next(reads), 'ios', '123', '1', pending['status']), pending)
        with self.assertRaisesRegex(RuntimeError, 'Unexpected native probe state'):
            runner.wait_report(lambda: json.dumps(self.report('passed')), 'ios', '123', '1', pending['status'])

    def test_future_or_completed_phase_cannot_skip_the_interruption(self):
        with self.assertRaisesRegex(RuntimeError, 'Unexpected native probe state'):
            runner.wait_report(lambda: '{"status":"passed"}', 'ios', '123', '1', 'ready_for_interruption')

    def test_unknown_expected_phase_is_rejected_before_reading(self):
        with patch.object(runner, 'command') as command:
            with self.assertRaisesRegex(RuntimeError, 'Unknown expected'):
                runner.wait_report(lambda: '', 'ios', '123', '1', 'unknown')
            command.assert_not_called()

    def drive_ios(self, pids, invalid_phase=None):
        events, launches = [], iter(pids)

        def command(args, **kwargs):
            if args[2:4] == ['list', 'runtimes']:
                return reply(out=json.dumps({'runtimes': [{'isAvailable': True, 'identifier': 'test.iOS-26-2'}]}))
            if args[2] == 'create':
                return reply(out=self.DEVICE)
            if args[2] == 'get_app_container':
                return reply(out='/tmp/owned-synthetic-ios-container')
            if args[2] == 'launch':
                pid = next(launches)
                events.append(('launch', pid))
                return reply(out=runner.APP + ': ' + pid)
            if args[2] == 'terminate':
                events.append(('terminate',))
            return reply()

        def wait(read, platform, run_id, attempt, status):
            events.append(('phase', status))
            report = self.report(status)
            if status == invalid_phase:
                report['transactionOpen'] = False
            runner.validate(report, platform, run_id, attempt, status)
            return report

        with patch.dict(runner.os.environ, {'RUNNER_TEMP': '/tmp/owned-synthetic-ios'}), \
             patch.object(runner, 'command', side_effect=command), patch.object(runner, 'wait_report', side_effect=wait), \
             patch.object(runner, 'interrupt_ios_audit_app', side_effect=lambda device, pid: events.append(('kill', pid))) as interrupt, \
             redirect_stdout(io.StringIO()):
            try:
                return runner.ios('123', '1'), events, interrupt.call_args_list
            except RuntimeError as error:
                return error, events, interrupt.call_args_list

    def drive_android(self, pids, invalid_phase=None):
        events, launches, state = [], iter(pids), {'pid': ''}

        def command(args, **kwargs):
            if args == ['adb', 'devices']:
                return reply(out='List of devices attached\nemulator-5554\tdevice\n')
            if args[-2:] == ['pidof', runner.APP]:
                return reply(out=state['pid'])
            if args[-3:] == ['am', 'force-stop', runner.APP]:
                events.append(('stop', state['pid']))
                state['pid'] = ''
            return reply()

        def launch(prefix):
            state['pid'] = next(launches)
            events.append(('launch', state['pid']))

        def wait(read, platform, run_id, attempt, status):
            events.append(('phase', status))
            report = {**self.report(status), 'platform': 'android', 'database': 'cv2_sqlite_audit_123_1_android'}
            if status == invalid_phase:
                report['transactionOpen'] = False
            runner.validate(report, platform, run_id, attempt, status)
            return report

        collector = Mock()
        collector.poll.return_value = 0
        with tempfile.TemporaryDirectory(prefix='cv-five-launches-') as directory, \
             patch.dict(runner.os.environ, {'RUNNER_TEMP': directory}), patch.object(runner, 'command', side_effect=command), \
             patch.object(runner.subprocess, 'Popen', return_value=collector), patch.object(runner, 'launch_android', side_effect=launch), \
             patch.object(runner, 'wait_report', side_effect=wait), patch.object(runner, 'android_diagnostics'), redirect_stdout(io.StringIO()):
            try:
                result = runner.android('123', '1')
            except RuntimeError as error:
                result = error
        collector.terminate.assert_not_called()
        collector.kill.assert_not_called()
        return result, events

    def test_ios_validates_five_phases_before_the_two_verified_interruptions(self):
        report, events, interrupts = self.drive_ios(['101', '102', '103', '104', '105'])
        self.assertEqual([event for event in events if event[0] == 'phase'], [('phase', status) for status in runner.PHASES])
        self.assertEqual(interrupts, [call(self.DEVICE, '102'), call(self.DEVICE, '104')])
        self.assertEqual(events[4:7], [('phase', 'ready_for_interruption'), ('kill', '102'), ('launch', '103')])
        self.assertEqual(events[10:13], [('phase', 'ready_for_write_interruption'), ('kill', '104'), ('launch', '105')])
        self.assertEqual(report['writeProcessRestart'], {'before': '103', 'after': '104'})
        self.assertTrue(report['writeForcedInterruption']['transactionOpenConfirmed'])

    def test_android_validates_five_phases_before_each_owned_app_stop(self):
        report, events = self.drive_android(['201', '202', '203', '204', '205'])
        self.assertEqual([event for event in events if event[0] == 'phase'], [('phase', status) for status in runner.PHASES])
        self.assertEqual([event for event in events if event[0] == 'stop'], [('stop', pid) for pid in ['201', '202', '203', '204']])
        self.assertEqual(report['writeForcedInterruption']['before'], '204')
        self.assertEqual(report['writeForcedInterruption']['after'], '205')
        self.assertTrue(report['writeForcedInterruption']['transactionOpenConfirmed'])

    def test_invalid_write_phase_cannot_authorize_the_second_interruption(self):
        error, events, interrupts = self.drive_ios(['101', '102', '103', '104', '105'], 'ready_for_write_interruption')
        self.assertIsInstance(error, RuntimeError)
        self.assertEqual(interrupts, [call(self.DEVICE, '102')])
        error, events = self.drive_android(['201', '202', '203', '204', '205'], 'ready_for_write_interruption')
        self.assertIsInstance(error, RuntimeError)
        self.assertNotIn(('stop', '204'), events)
        self.assertNotIn(('launch', '205'), events)

    def test_reused_or_nonpositive_process_ids_cannot_produce_native_success(self):
        for pids in [['101', '102', '103', '104', '103'], ['101', '102', '103', '104', '0']]:
            result, _, _ = self.drive_ios(pids)
            self.assertIsInstance(result, RuntimeError)
            self.assertRegex(str(result), 'five distinct')
            result, _ = self.drive_android(pids)
            self.assertIsInstance(result, RuntimeError)
            self.assertRegex(str(result), 'five distinct')

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
