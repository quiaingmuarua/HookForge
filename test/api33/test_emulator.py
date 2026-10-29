import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

import emulator


@unittest.skipUnless(os.name == 'posix', 'POSIX process-group lifecycle is exercised on Linux/macOS CI')
class EmulatorLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.sdk = self.root / 'sdk'
        for name in ['platform-tools/adb', 'emulator/emulator', 'cmdline-tools/latest/bin/avdmanager']:
            executable = self.sdk / name
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.write_text('#!/bin/sh\n')
            executable.chmod(0o755)
        image = self.sdk / 'system-images/android-33/default/arm64-v8a/source.properties'
        image.parent.mkdir(parents=True)
        image.write_text('AndroidVersion.ApiLevel=33\nSystemImage.Abi=arm64-v8a\nSystemImage.TagId=default\nPkg.Revision=2\n')
        self.args = argparse.Namespace(sdk_root=self.sdk, avd_home=self.root / 'avds',
                                       avd_name='agentforge-test', port=5580, abi='arm64-v8a',
                                       output=self.root / 'evidence')
        self.info = {'started': 'Tue Oct 20 12:00:00 2026', 'pgid': 5500,
                     'command': '/sdk/emulator/qemu/darwin-aarch64/qemu-system-aarch64 -avd agentforge-test -port 5580'}
        self.calls = []

    def command(self, argv, **kwargs):
        argv = [str(item) for item in argv]
        self.calls.append(argv)
        if '-accel-check' in argv:
            text = 'accel:\n0\nHypervisor.Framework OS X Version 15.0\n'
        elif argv[-1] == 'devices':
            text = 'List of devices attached\n'
        elif argv[-1] == 'sys.boot_completed':
            text = '1\n'
        elif argv[-1] == 'root':
            text = 'restarting adbd as root\n'
        elif argv[-2:] == ['id', '-u']:
            text = '0\n'
        elif argv[-1] == 'ro.build.version.sdk':
            text = '33\n'
        elif argv[-1] == 'ro.product.cpu.abi':
            text = 'arm64-v8a\n'
        elif argv[-3:] == ['emu', 'avd', 'name']:
            text = 'agentforge-test\nOK\n'
        else:
            text = ''
        return subprocess.CompletedProcess(argv, 0, text, '')

    def launch(self, command=None):
        process = Mock(pid=5500)
        process.poll.return_value = None
        patches = [patch.object(emulator, 'command', side_effect=command or self.command),
                   patch.object(emulator, 'process_info', return_value=self.info),
                   patch.object(emulator, 'check_ports'),
                   patch.object(emulator.platform, 'system', return_value='Darwin'),
                   patch.object(emulator.os, 'getpgid', return_value=5500),
                   patch.object(emulator.subprocess, 'Popen', return_value=process)]
        for item in patches:
            item.start()
            self.addCleanup(item.stop)
        return process

    def state(self):
        return json.loads((self.args.output / 'state.json').read_text())

    def cleanup_result(self):
        return json.loads((self.args.output / 'cleanup.json').read_text())

    def test_start_records_exact_owned_identity_and_bounded_resources(self):
        self.launch()
        state = emulator.start(self.args)
        self.assertEqual('passed', state['status'])
        self.assertEqual('passed', state['macAccelCheck']['status'])
        self.assertEqual({'sdk': 33, 'abi': 'arm64-v8a', 'uid': 0, 'avdName': 'agentforge-test'}, state['device'])
        self.assertEqual(5500, state['pid'])
        self.assertEqual(5500, state['pgid'])
        self.assertIn('-wipe-data', state['command'])
        self.assertIn(['-cores', '2'], [state['command'][i:i + 2] for i in range(len(state['command']))])
        self.assertIn(['-memory', '2048'], [state['command'][i:i + 2] for i in range(len(state['command']))])
        emulator.subprocess.Popen.assert_called_once()
        self.assertTrue(emulator.subprocess.Popen.call_args.kwargs['start_new_session'])
        self.assertFalse((self.args.output / 'cleanup.json').exists())

    def test_port_conflict_does_not_spawn_or_delete_foreign_resources(self):
        self.launch()
        emulator.check_ports.side_effect = RuntimeError('Port 5580 occupied')
        with self.assertRaisesRegex(RuntimeError, 'occupied'):
            emulator.start(self.args)
        emulator.subprocess.Popen.assert_not_called()
        self.assertEqual('failed', self.state()['status'])
        self.assertFalse(self.cleanup_result()['owned'])

    def test_real_listening_socket_still_blocks_reusable_port_probe(self):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            listener.bind(('127.0.0.1', 0))
            listener.listen(1)
            port = listener.getsockname()[1]
            with self.assertRaisesRegex(RuntimeError, f'Port {port} is occupied'):
                emulator.check_ports(port)
            # A refused probe leaves the pre-existing listener operational.
            with socket.create_connection(('127.0.0.1', port), timeout=1) as client:
                peer, _ = listener.accept()
                peer.close()
                self.assertEqual(b'', client.recv(1))

    def test_existing_avd_is_never_reused_or_removed(self):
        self.launch()
        foreign = self.args.avd_home / 'agentforge-test.avd'
        foreign.mkdir(parents=True)
        evidence = foreign / 'foreign-data'
        evidence.write_text('preserve')
        with self.assertRaisesRegex(FileExistsError, 'already exists'):
            emulator.start(self.args)
        emulator.subprocess.Popen.assert_not_called()
        self.assertEqual('preserve', evidence.read_text())

    def test_root_failure_cleans_only_owned_group_and_avd(self):
        def fail_root(argv, **kwargs):
            if str(argv[-1]) == 'root':
                raise RuntimeError('adbd cannot run as root')
            return self.command(argv, **kwargs)
        self.launch(fail_root)
        with patch.object(emulator, 'group_members', side_effect=[[5500], [], [], []]), \
             patch.object(emulator.os, 'killpg') as kill:
            with self.assertRaisesRegex(RuntimeError, 'cannot run as root'):
                emulator.start(self.args)
        kill.assert_called_once_with(5500, signal.SIGTERM)
        self.assertEqual('passed', self.cleanup_result()['status'])
        self.assertTrue(self.cleanup_result()['owned'])
        self.assertFalse(self.state()['processOwned'])
        self.assertFalse(self.state()['avdOwned'])
        self.assertFalse((self.args.avd_home / '.agentforge-agentforge-test.json').exists())

    def test_identity_capture_failure_cleans_the_still_owned_child_handle(self):
        self.launch()
        emulator.process_info.side_effect = RuntimeError('ps unavailable during acquisition')
        with patch.object(emulator, 'group_members', return_value=[]), \
             patch.object(emulator.os, 'killpg') as kill:
            with self.assertRaisesRegex(RuntimeError, 'ps unavailable'):
                emulator.start(self.args)
        kill.assert_called_once_with(5500, signal.SIGTERM)
        self.assertEqual('passed', self.cleanup_result()['status'])
        self.assertFalse(self.state()['processOwned'])
        self.assertFalse(self.state()['avdOwned'])

    def test_failure_evidence_write_does_not_prevent_owned_resource_cleanup(self):
        def fail_root(argv, **kwargs):
            if str(argv[-1]) == 'root':
                raise RuntimeError('adbd cannot run as root')
            return self.command(argv, **kwargs)
        self.launch(fail_root)
        write = emulator.write_json

        def fail_evidence(path, value):
            if path.name == 'state.json' and value.get('status') == 'failed':
                raise OSError('evidence storage unavailable')
            write(path, value)

        with patch.object(emulator, 'write_json', side_effect=fail_evidence), \
             patch.object(emulator, 'group_members', side_effect=[[5500], [], [], []]), \
             patch.object(emulator.os, 'killpg') as kill:
            with self.assertRaisesRegex(OSError, 'evidence storage unavailable'):
                emulator.start(self.args)
        kill.assert_called_once_with(5500, signal.SIGTERM)
        self.assertFalse((self.args.avd_home / '.agentforge-agentforge-test.json').exists())
        self.assertEqual('failed', self.cleanup_result()['status'])
        self.assertTrue(all(action['passed'] for action in self.cleanup_result()['actions']))

    def test_boot_timeout_writes_failure_and_runs_cleanup(self):
        self.launch()
        with patch.object(emulator.time, 'monotonic', side_effect=[0, 181, 181]), \
             patch.object(emulator, 'group_members', side_effect=[[5500], [], [], []]), \
             patch.object(emulator.os, 'killpg'):
            with self.assertRaisesRegex(TimeoutError, '180 seconds'):
                emulator.start(self.args)
        self.assertEqual('failed', self.state()['status'])
        self.assertEqual('passed', self.cleanup_result()['status'])

    def test_signal_during_boot_records_interruption_and_cleans(self):
        def interrupt(argv, **kwargs):
            if str(argv[-1]) == 'sys.boot_completed':
                raise InterruptedError('signal 15')
            return self.command(argv, **kwargs)
        self.launch(interrupt)
        with patch.object(emulator, 'group_members', side_effect=[[5500], [], [], []]), \
             patch.object(emulator.os, 'killpg'):
            with self.assertRaises(InterruptedError):
                emulator.start(self.args)
        self.assertIn('signal 15', self.state()['errors'][0])
        self.assertEqual('passed', self.cleanup_result()['status'])

    def test_recycled_pid_is_not_signalled_and_avd_is_retained(self):
        self.launch()
        emulator.start(self.args)
        emulator.process_info.return_value = {**self.info, 'started': 'Wed Oct 21 12:00:00 2026'}
        with patch.object(emulator, 'group_members', return_value=[5500]), patch.object(emulator.os, 'killpg') as kill:
            result = emulator.stop(self.args.output)
        kill.assert_not_called()
        self.assertEqual('failed', result['status'])
        self.assertTrue(self.state()['avdOwned'])
        self.assertIn('foreign process', ' '.join(result['errors']))

    def test_missing_leader_with_remaining_group_fails_closed(self):
        self.launch()
        emulator.start(self.args)
        emulator.process_info.return_value = None
        with patch.object(emulator, 'group_members', return_value=[5501]), patch.object(emulator.os, 'killpg') as kill:
            result = emulator.stop(self.args.output)
        kill.assert_not_called()
        self.assertEqual('failed', result['status'])

    def test_reap_of_exited_owned_process_is_idempotent(self):
        self.launch()
        emulator.start(self.args)
        directory = self.args.avd_home / 'agentforge-test.avd'
        directory.mkdir()
        (directory / 'userdata').write_text('owned')
        emulator.process_info.return_value = None
        with patch.object(emulator, 'group_members', return_value=[]), patch.object(emulator.os, 'killpg') as kill:
            first = emulator.stop(self.args.output)
            second = emulator.stop(self.args.output)
        kill.assert_not_called()
        self.assertEqual('passed', first['status'])
        self.assertTrue(first['owned'])
        self.assertFalse(directory.exists())
        self.assertEqual('passed', second['status'])
        self.assertFalse(second['owned'])
        self.assertEqual([], second['actions'])

    def test_wrong_device_identity_is_rejected_before_adb_root(self):
        def wrong_abi(argv, **kwargs):
            result = self.command(argv, **kwargs)
            if str(argv[-1]) == 'ro.product.cpu.abi':
                result.stdout = 'x86_64\n'
            return result
        self.launch(wrong_abi)
        with patch.object(emulator, 'group_members', side_effect=[[5500], [], [], []]), \
             patch.object(emulator.os, 'killpg'):
            with self.assertRaisesRegex(RuntimeError, 'API/ABI/AVD identity'):
                emulator.start(self.args)
        self.assertFalse(any(call[-1] == 'root' for call in self.calls))

    def test_changed_avd_marker_is_not_deleted(self):
        self.launch()
        emulator.start(self.args)
        marker = self.args.avd_home / '.agentforge-agentforge-test.json'
        marker.write_text('{}')
        emulator.process_info.return_value = None
        with patch.object(emulator, 'group_members', return_value=[]):
            result = emulator.stop(self.args.output)
        self.assertEqual('failed', result['status'])
        self.assertEqual('{}', marker.read_text())

    def test_stop_without_start_records_no_owned_resources(self):
        result = emulator.stop(self.args.output)
        self.assertEqual('passed', result['status'])
        self.assertFalse(result['owned'])
        self.assertEqual([], result['actions'])

    def test_existing_incomplete_state_is_not_treated_as_no_start(self):
        self.args.output.mkdir()
        (self.args.output / 'state.json').write_text('{"schemaVersion":1,"status":"passed"}')
        with patch.object(emulator.os, 'killpg') as kill:
            result = emulator.stop(self.args.output)
        kill.assert_not_called()
        self.assertEqual('failed', result['status'])
        self.assertIn('missing required ownership', ' '.join(result['errors']))

    def test_invalid_ownership_types_or_coordinates_fail_before_signalling(self):
        self.launch()
        emulator.start(self.args)
        original = self.state()
        for field, value in [('processOwned', 'false'), ('avdOwned', None), ('port', 22),
                             ('serial', 'emulator-5554'), ('pgid', 5501), ('avdHome', '/tmp/../foreign')]:
            with self.subTest(field=field):
                state = {**original, field: value}
                (self.args.output / 'state.json').write_text(json.dumps(state))
                with patch.object(emulator.os, 'killpg') as kill:
                    result = emulator.stop(self.args.output)
                kill.assert_not_called()
                self.assertEqual('failed', result['status'])

    def test_unknown_abi_or_unsafe_port_is_rejected(self):
        for abi, port in [('arm64', 5580), ('arm64-v8a', 5581), ('x86_64', 22)]:
            with self.assertRaises(ValueError):
                emulator.validate_coordinates(abi, 'safe-avd', port)
        with self.assertRaises(ValueError):
            emulator.validate_coordinates('arm64-v8a', '../foreign', 5580)


if __name__ == '__main__':
    unittest.main()
