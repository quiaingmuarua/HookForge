from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import MagicMock, Mock, patch

import run as driver
from prepare import TARGETS, load_spec
from test_prepare import apk_bytes


class NodeConnectionTests(unittest.TestCase):
    def exercise(self, mode, abi='x86_64', cli_exit=0, actual_abi=None, sdk='33',
                 apk_abi=None, process_arch=None, omit_environment=False, supply_apk=False,
                 omit_abi=False, host='node', bridge_error=None,
                 verification_pids='42', verification_cmdline=driver.PACKAGE + '\0'):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / 'case'
            manifest = root / 'production.json'
            manifest.write_text('{}', encoding='utf-8')
            spec = load_spec(abi=abi)
            manager = Mock(side_effect=AssertionError('Node must own the only Frida connection'))
            client = SimpleNamespace(__version__=spec['fridaVersion'], get_device_manager=manager)
            native = Mock()
            native.exports_sync.info.return_value = {
                'pid': 42, 'platform': 'linux', 'arch': process_arch or spec['processArch']}
            transport = Mock()
            if host == 'python':
                transport.spawn.return_value = 42
                transport.attach.return_value.create_script.side_effect = [native, Mock()]
                manager.side_effect = None
                manager.return_value.add_remote_device.return_value = transport
                client.Cancellable = MagicMock
                client.ServerNotRunningError = type('ServerNotRunningError', (Exception,), {})
                client.TransportError = type('TransportError', (Exception,), {})
            launches = []
            adb_requests = []
            fixture_apk = apk_bytes(apk_abi or abi)
            supplied = root / 'app.apk'
            supplied.write_bytes(fixture_apk)

            def command(argv, **kwargs):
                if (argv[0].endswith('/esbuild') or
                        (argv[0] == 'node' and Path(argv[1]).name == 'esbuild')):
                    Path(next(arg.split('=', 1)[1] for arg in argv if arg.startswith('--outfile='))).write_text('fixture Java agent')
                    stdout = ''
                elif argv[0] == 'node':
                    if argv[1] == '--version':
                        stdout = 'v' + spec['nodeVersion']
                    elif argv[1].endswith('production-artifact.mjs'):
                        stdout = 'verified'
                    elif Path(argv[1]).parts[-2:] == ('node-cli', 'run.js'):
                        launches.append(argv)
                        target = Path(argv[argv.index('--result') + 1])
                        messages = [] if omit_environment else [{'type': 'send', 'payload': {
                            'type': 'loader-ready', 'stats': {'environment': {
                                'platform': 'android', 'appId': driver.PACKAGE,
                                'arch': process_arch or spec['processArch']}}}}]
                        target.write_text(json.dumps({
                            'status': 'passed' if cli_exit == 0 else 'failed',
                            'ready': cli_exit == 0, 'pid': 42,
                            'modules': {'android/runtime-bypass': 'activated'},
                            'errors': [] if cli_exit == 0 else ['hook assertion failed'],
                            'messages': messages,
                            'cleanup': [{'action': 'script.unload', 'status': 'passed'},
                                        {'action': 'session.detach', 'status': 'passed'}],
                        }), encoding='utf-8')
                        return SimpleNamespace(returncode=cli_exit, stdout='', stderr='')
                    else:
                        raise AssertionError(argv)
                elif argv[0] == 'adb':
                    request = argv[3:]
                    adb_requests.append(request)
                    if request[:2] == ['shell', 'getprop']:
                        stdout = {'ro.build.version.sdk': sdk, 'ro.product.cpu.abi': actual_abi or abi,
                                  'sys.boot_completed': '1', 'ro.build.version.release': '13',
                                  'ro.build.fingerprint': 'fixture'}[request[2]]
                    elif request[:3] == ['shell', 'pm', 'path']:
                        stdout = 'package:/data/app/detect-env.apk'
                    elif request[0] == 'pull':
                        Path(request[2]).write_bytes(fixture_apk)
                        stdout = ''
                    elif request[:2] == ['shell', '/data/local/tmp/agentforge-frida-server']:
                        stdout = spec['fridaVersion']
                    elif request[:2] == ['shell', 'sha256sum']:
                        stdout = spec['serverSha256'] + '  server'
                    elif request[:2] == ['shell', 'pidof']:
                        stdout = verification_pids if launches else '42'
                    elif request == ['shell', 'cat', '/proc/42/cmdline']:
                        stdout = verification_cmdline
                    elif request[:2] == ['forward', 'tcp:0']:
                        stdout = '12345'
                    elif (request[:2] == ['forward', '--remove'] or request[:2] == ['shell', 'am']
                          or request[0] in ['logcat', 'install']):
                        stdout = ''
                    else:
                        raise AssertionError(argv)
                elif argv[0] == 'git':
                    stdout = 'fixture commit'
                else:
                    raise AssertionError(argv)
                return SimpleNamespace(returncode=0, stdout=stdout, stderr='')

            argv = ['run.py', '--host', host, '--mode', mode, '--adb', 'adb', '--node', 'node',
                    '--serial', 'emulator-5554', '--production-manifest', str(manifest), '--output', str(output)]
            if not omit_abi:
                argv.extend(['--abi', abi])
            if supply_apk:
                argv.extend(['--apk', str(supplied)])
            for relative in ['node_modules/esbuild/bin/esbuild', 'packages/runtime/java-bridge.ts']:
                source = root / relative
                source.parent.mkdir(parents=True, exist_ok=True)
                source.write_text('fixture source', encoding='utf-8')
            with patch('sys.argv', argv), patch.dict('sys.modules', {'frida': client}), \
                 patch.object(driver, 'ROOT', root), \
                 patch.object(driver, 'check_java_bridge', return_value=spec['javaBridgePatch'],
                              side_effect=bridge_error), \
                 patch.object(driver.subprocess, 'run', side_effect=command), \
                 redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                code = driver.main()
            if host == 'node':
                manager.assert_not_called()
            else:
                native.exports_sync.install.assert_not_called()
                transport.attach.return_value.detach.assert_called_once()
            result = json.loads((output / 'result.json').read_text(encoding='utf-8'))
            self.assertLessEqual(len(launches), 1, 'Failed behavior must not trigger another CLI run')
            if launches:
                self.assertEqual(mode == 'spawn', '--spawn' in launches[0])
                self.assertEqual([{'action': 'adb.forward.remove', 'status': 'passed'}], result['cleanup'])
            return code, result, launches, adb_requests

    def test_only_the_production_cli_connects_for_both_abis_and_modes(self):
        for abi in TARGETS:
            for mode in ('attach', 'spawn'):
                with self.subTest(abi=abi, mode=mode):
                    code, result, launches, _ = self.exercise(mode, abi=abi)
                    self.assertEqual(0, code, result['errors'])
                    self.assertEqual(1, len(launches))
                    self.assertEqual('passed', result['status'])
                    self.assertEqual(3, result['schemaVersion'])
                    self.assertEqual(abi, result['requestedAbi'])
                    self.assertEqual(load_spec(abi=abi)['processArch'], result['processArch'])
                    self.assertEqual(abi, result['installedApk']['native']['abi'])

    def test_failed_cli_behavior_is_preserved_without_reconnecting_or_retrying(self):
        code, result, launches, _ = self.exercise('spawn', cli_exit=1)
        self.assertEqual(1, code)
        self.assertEqual(1, len(launches))
        self.assertEqual('failed', result['status'])
        self.assertIn('Command failed (1)', result['errors'][0]['message'])

    def test_spawn_keeps_the_original_pid_when_a_helper_has_the_same_name(self):
        code, result, launches, _ = self.exercise('spawn', verification_pids='42 77')
        self.assertEqual(0, code, result['errors'])
        self.assertEqual(1, len(launches))
        self.assertEqual({'pid': 42, 'matchingPids': ['42', '77'], 'cmdline': driver.PACKAGE},
                         result['checks']['targetProcess'])

    def test_a_replacement_pid_or_changed_process_name_still_fails(self):
        for kwargs, error in [({'verification_pids': '77'}, 'Node target exited or restarted'),
                              ({'verification_pids': '42 77', 'verification_cmdline': 'another.app\0'},
                               'Target PID belongs to a different process')]:
            with self.subTest(kwargs=kwargs):
                code, result, launches, _ = self.exercise('spawn', **kwargs)
                self.assertEqual(1, code)
                self.assertEqual(1, len(launches))
                self.assertEqual('failed', result['status'])
                self.assertIn(error, result['errors'][0]['message'])

    def test_unpatched_bridge_is_rejected_before_device_changes_or_injection(self):
        code, result, launches, requests = self.exercise(
            'spawn', bridge_error=ValueError('Java bridge patched source checksum mismatch'))
        self.assertEqual(1, code)
        self.assertEqual([['logcat', '-d', '-t', '800']], requests)
        self.assertEqual([], launches)
        self.assertIn('patched source checksum mismatch', result['errors'][0]['message'])

    def test_existing_cli_without_abi_still_selects_x86_64(self):
        code, result, _, _ = self.exercise('attach', omit_abi=True)
        self.assertEqual(0, code, result['errors'])
        self.assertEqual('x86_64', result['requestedAbi'])

    def test_python_probe_rejects_wrong_process_arch_before_installing_hooks(self):
        for mode in ['attach', 'spawn']:
            with self.subTest(mode=mode):
                code, result, launches, _ = self.exercise(mode, abi='arm64-v8a', host='python', process_arch='x64')
                self.assertEqual(1, code)
                self.assertEqual([], launches)
                self.assertIn('Process.arch mismatch', result['errors'][0]['message'])
                self.assertEqual('x64', result['checks']['nativeRuntime']['arch'])

    def test_wrong_device_or_apk_is_rejected_before_install_or_frida_connection(self):
        cases = [({'abi': 'arm64-v8a', 'actual_abi': 'x86_64'}, 'Expected API 33'),
                 ({'abi': 'x86_64', 'sdk': '34'}, 'Expected API 33'),
                 ({'abi': 'arm64-v8a', 'apk_abi': 'x86_64'}, 'must contain exactly one')]
        for kwargs, expected in cases:
            with self.subTest(kwargs=kwargs):
                code, result, launches, requests = self.exercise('attach', supply_apk=True, **kwargs)
                self.assertEqual(1, code)
                self.assertEqual([], launches)
                self.assertFalse(any(request[0] in ['install', 'forward', 'push'] for request in requests))
                self.assertIn(expected, result['errors'][0]['message'])

    def test_installed_apk_requires_the_selected_abi_even_without_supplied_apk(self):
        code, result, launches, requests = self.exercise('attach', abi='arm64-v8a', apk_abi='x86_64')
        self.assertEqual(1, code)
        self.assertEqual([], launches)
        self.assertFalse(any(request[0] == 'forward' for request in requests))
        self.assertIn('must contain exactly one', result['errors'][0]['message'])

    def test_observed_process_arch_and_loader_environment_are_required(self):
        for kwargs, expected in [({'process_arch': 'x64'}, 'Process.arch mismatch'),
                                 ({'omit_environment': True}, 'loader-ready environment')]:
            with self.subTest(kwargs=kwargs):
                code, result, launches, _ = self.exercise('spawn', abi='arm64-v8a', **kwargs)
                self.assertEqual(1, code)
                self.assertEqual(1, len(launches))
                self.assertIn(expected, result['errors'][0]['message'])


if __name__ == '__main__':
    unittest.main()
