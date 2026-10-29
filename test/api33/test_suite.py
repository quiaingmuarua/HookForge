import copy
from datetime import datetime, timedelta, timezone
import json
import contextlib
import io
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch

import suite
import report
from prepare import JAVA_BRIDGE_PATCH, ROOT, TARGETS, load_spec, sha256
from test_prepare import apk_bytes

COMMIT = '1' * 40
NOW = datetime.now(timezone.utc)


def runtime_result(abi, host, mode):
    spec = load_spec(abi=abi)
    return {'schemaVersion': 3, 'requestedAbi': abi, 'status': 'passed', 'stage': 'complete',
            'hostType': host, 'mode': mode, 'toolchainLock': spec, 'processArch': spec['processArch'],
            'javaBridgePatch': spec['javaBridgePatch'],
            'host': {'checkoutCommit': COMMIT},
            'checks': {'device': {'sdk': 33, 'abi': abi}},
            'installedApk': {'native': {'abi': abi}}, 'server': {'sha256': spec['serverSha256']}}


def runtime_summary(abi='x86_64'):
    spec = load_spec(abi=abi)
    return {'schemaVersion': 3, 'requestedAbi': abi, 'toolchainLock': spec, 'status': 'passed',
            'checkoutCommit': COMMIT, 'startedAt': (NOW - timedelta(minutes=5)).isoformat(),
            'finishedAt': (NOW - timedelta(minutes=2)).isoformat(),
            'cases': [{'schemaVersion': 3, 'host': host, 'mode': mode, 'status': 'passed',
                       'checkoutCommit': COMMIT,
                       'javaBridgePatch': spec['javaBridgePatch'],
                       'requestedAbi': abi, 'abi': abi, 'sdk': 33, 'processArch': spec['processArch'],
                       'serverSha256': spec['serverSha256']}
                      for host in ['python', 'node'] for mode in ['attach', 'spawn']]}


def real_case(abi='x86_64'):
    spec = load_spec(abi=abi)
    return {'schemaVersion': 3, 'requestedAbi': abi, 'agentSource': 'production-artifact',
            'startedAt': (NOW - timedelta(minutes=1)).isoformat(),
            'finishedAt': (NOW - timedelta(seconds=1)).isoformat(),
            'apiAgentSha256': 'a' * 64, 'environment': {
                'sdk': 33, 'abi': abi, 'serverArch': spec['serverArch'], 'processArch': spec['processArch'],
                'frida': spec['fridaVersion'], 'serverVersion': spec['fridaVersion'],
                'serverSha256': spec['serverSha256'], 'target': {'arch': spec['processArch']}},
            'reuse': {'requested': True, 'target': {'arch': spec['processArch']}},
            'evaluation': {'passed': True, 'failures': []}}


class SuiteTests(unittest.TestCase):
    def exercise(self, abi='x86_64', tools_override=None, child_override=None, failed_mode=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec = load_spec(abi=abi)
            tools = {'schemaVersion': 2, 'requestedAbi': abi, 'status': 'passed', 'lock': spec,
                     'javaBridgePatch': spec['javaBridgePatch'],
                     'python': 'python', 'node': 'node', 'server': 'server', 'serverSha256': spec['serverSha256']}
            tools.update(tools_override or {})
            toolchain = root / 'toolchain.json'
            toolchain.write_text(json.dumps(tools), encoding='utf-8')
            apk = root / 'app.apk'
            apk.write_bytes(apk_bytes(abi))
            out = root / 'results'
            commands = []

            def run(command, **kwargs):
                commands.append(command)
                target = Path(command[command.index('--output') + 1])
                target.mkdir()
                host = command[command.index('--host') + 1]
                mode = command[command.index('--mode') + 1]
                result = runtime_result(abi, host, mode)
                if child_override:
                    child_override(result)
                (target / 'result.json').write_text(json.dumps(result), encoding='utf-8')
                return SimpleNamespace(returncode=1 if target.name == failed_mode else 0)

            argv = ['suite.py', '--abi', abi, '--toolchain', str(toolchain), '--apk', str(apk), '--adb', 'adb', '--output', str(out)]
            with patch('sys.argv', argv), patch.object(suite.subprocess, 'run', side_effect=run), \
                 patch.object(suite, 'checkout_commit', return_value=COMMIT), \
                 contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = suite.main()
            return code, json.loads((out / 'summary.json').read_text(encoding='utf-8')), commands

    def test_both_abis_are_forwarded_to_every_host_mode_and_recorded(self):
        for abi in TARGETS:
            with self.subTest(abi=abi):
                code, summary, commands = self.exercise(abi)
                self.assertEqual(0, code)
                self.assertEqual('passed', summary['status'])
                self.assertEqual(4, len(commands))
                self.assertTrue(all(command[command.index('--abi') + 1] == abi for command in commands))
                self.assertTrue(all(case['abi'] == abi for case in summary['cases']))

    def test_nonzero_case_exit_fails_suite_and_other_modes_still_run(self):
        code, summary, commands = self.exercise(failed_mode='python-spawn')
        self.assertEqual(1, code)
        self.assertEqual('failed', summary['status'])
        self.assertEqual(4, len(commands))
        self.assertEqual(['passed', 'failed', 'passed', 'passed'], [case['status'] for case in summary['cases']])

    def test_old_or_mixed_toolchain_evidence_prevents_all_device_commands(self):
        for override in [{'schemaVersion': 1}, {'requestedAbi': 'x86_64'},
                         {'lock': load_spec()}, {'serverSha256': load_spec()['serverSha256']},
                         {'javaBridgePatch': None}, {'javaBridgePatch': {}}, {'status': 'failed'}]:
            with self.subTest(override=override):
                code, summary, commands = self.exercise('arm64-v8a', tools_override=override)
                self.assertEqual(1, code)
                self.assertEqual([], commands)
                self.assertEqual('preflight', summary['stage'])

    def test_zero_exit_cannot_accept_old_or_mixed_child_evidence(self):
        variants = [lambda result: result.update(schemaVersion=1),
                    lambda result: result.update(requestedAbi='x86_64'),
                    lambda result: result.update(processArch='x64'),
                    lambda result: result['checks']['device'].update(abi='x86_64'),
                    lambda result: result['checks']['device'].update(sdk=34),
                    lambda result: result['installedApk'].update(native={}),
                    lambda result: result.update(toolchainLock=load_spec()),
                    lambda result: result.pop('javaBridgePatch'),
                    lambda result: result['javaBridgePatch'].update(patchedSha256='0' * 64),
                    lambda result: result['host'].update(checkoutCommit='2' * 40),
                    lambda result: result.update(hostType='other')]
        for change in variants:
            with self.subTest(change=change):
                code, summary, commands = self.exercise('arm64-v8a', child_override=change)
                self.assertEqual(1, code)
                self.assertEqual(4, len(commands))
                self.assertTrue(all(case['status'] == 'failed' for case in summary['cases']))


class EvidenceTests(unittest.TestCase):
    def exercise(self, summary=None, case=None, require_case=False, abi='x86_64', cleanup=None,
                 require_cleanup=False, steps=None, job_status='success', image=False, manifest_override=None):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            if summary is not None:
                (root / 'summary.json').write_text(summary if isinstance(summary, str) else json.dumps(summary), encoding='utf-8')
            evidence = root / 'rootbeer' / 'result.json'
            evidence.parent.mkdir()
            if case is not None:
                evidence.write_text(case if isinstance(case, str) else json.dumps(case), encoding='utf-8')
                manifest = {'schemaVersion': 2, 'production': True, 'commit': COMMIT,
                            'javaBridgePatch': load_spec(abi=abi)['javaBridgePatch'],
                            'nodeVersion': 'v' + load_spec(abi=abi)['nodeVersion'],
                            'packageLockSha256': sha256(ROOT / 'package-lock.json'),
                            'files': {'dist/android-api.js': 'a' * 64}}
                manifest.update(manifest_override or {})
                (evidence.parent / 'production-manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
            (evidence.parent / 'report.md').write_text('Original APK comparison', encoding='utf-8')
            cleanup_path = root / 'emulator' / 'cleanup.json'
            if cleanup is not None:
                cleanup_path.parent.mkdir()
                cleanup_path.write_text(cleanup if isinstance(cleanup, str) else json.dumps(cleanup), encoding='utf-8')
            sdk = root / 'sdk'
            if image:
                for target in TARGETS:
                    properties = sdk / f'system-images/android-33/default/{target}/source.properties'
                    properties.parent.mkdir(parents=True)
                    properties.write_text(f'Image ABI={target}', encoding='utf-8')
            argv = ['report.py', '--abi', abi, '--output', str(root)]
            if require_case:
                argv.extend(['--case-result', str(evidence)])
            if require_cleanup:
                argv.extend(['--cleanup-result', str(cleanup_path)])
            with patch('sys.argv', argv), \
                 patch.object(report, 'checkout_commit', return_value=COMMIT), \
                 patch.dict('os.environ', {'FRIDA_JOB_STATUS': job_status, 'FRIDA_STEP_RESULTS': json.dumps(steps or {}),
                                          'GITHUB_STEP_SUMMARY': '', 'ANDROID_HOME': str(sdk)}), \
                 patch.object(report.subprocess, 'run', side_effect=FileNotFoundError('SDK unavailable')), \
                 contextlib.redirect_stdout(io.StringIO()):
                code = report.main()
            result = json.loads((root / 'job-result.json').read_text(encoding='utf-8'))
            return code, result, (root / 'summary.md').read_text(encoding='utf-8')

    def test_initialization_failure_is_reported_without_case_results_or_sdk(self):
        with tempfile.TemporaryDirectory() as temporary:
            checkout = Path(temporary)
            for relative in ['package-lock.json', '.node-version', JAVA_BRIDGE_PATCH]:
                target = checkout / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((ROOT / relative).read_bytes())
            self.assertFalse((checkout / 'node_modules').exists())
            with patch.object(report, 'load_spec', side_effect=lambda abi: load_spec(checkout, abi=abi)):
                code, result, markdown = self.exercise(
                    abi='arm64-v8a', steps={'sdk': {'outcome': 'failure'}}, job_status='failure')
        self.assertEqual(1, code)
        self.assertEqual('failed', result['status'])
        self.assertEqual(['sdk'], result['failedSteps'])
        self.assertEqual('initialization', result['suite']['stage'])
        self.assertEqual('arm64-v8a', result['requestedAbi'])
        self.assertEqual('failed', result['proofs']['runtimeMechanisms']['status'])
        self.assertFalse(any('Invalid checkout/toolchain' in error for error in result['errors']))
        self.assertIn('initialization failed', markdown)

    def test_consumer_commit_is_distinct_from_the_tool_provenance(self):
        with patch.dict('os.environ', {'CONSUMER_COMMIT': '2' * 40,
                                      'GITHUB_REPOSITORY': 'quiaingmuarua/AgentForge'}):
            code, result, _ = self.exercise(summary=runtime_summary(), case=real_case(), require_case=True)
        self.assertEqual(0, code)
        self.assertEqual(COMMIT, result['commit'])
        self.assertEqual('2' * 40, result['consumerCommit'])
        self.assertEqual('quiaingmuarua/AgentForge', result['consumerRepository'])

    def test_real_case_is_required_even_if_all_base_cases_pass(self):
        for abi in TARGETS:
            good = real_case(abi)
            variants = [None, '{broken', [], {**good, 'schemaVersion': 2},
                        {**good, 'agentSource': 'local-build'},
                        {**good, 'reuse': {'requested': False}},
                        {**good, 'evaluation': {'passed': False, 'failures': ['restore failed']}}, good]
            for variant in variants:
                with self.subTest(abi=abi, variant=variant):
                    code, result, markdown = self.exercise(runtime_summary(abi), variant, require_case=True, abi=abi)
                    self.assertEqual(0 if variant == good else 1, code)
                    self.assertEqual('missing' if variant is None else 'passed' if variant == good else 'failed', result['rootbeer']['status'])
                    self.assertEqual('passed', result['proofs']['runtimeMechanisms']['status'])
                    self.assertEqual(result['rootbeer']['status'], result['proofs']['sharedApiBehavior']['status'])
                    if variant == good:
                        self.assertEqual('a' * 64, result['rootbeer']['apiAgentSha256'])
                        self.assertIn('Original APK comparison', markdown)

    def test_report_rejects_other_abi_or_unobserved_process_arch_case(self):
        changes = [lambda case: case.update(requestedAbi='x86_64'),
                   lambda case: case['environment'].update(abi='x86_64'),
                   lambda case: case['environment'].update(processArch='x64'),
                   lambda case: case['environment']['target'].update(arch='x64'),
                   lambda case: case['reuse']['target'].update(arch='x64'),
                   lambda case: case['environment'].update(serverSha256=load_spec()['serverSha256'])]
        for change in changes:
            case = real_case('arm64-v8a')
            change(case)
            with self.subTest(case=case):
                code, result, _ = self.exercise(runtime_summary('arm64-v8a'), case, require_case=True, abi='arm64-v8a')
                self.assertEqual(1, code)
                self.assertEqual('passed', result['proofs']['runtimeMechanisms']['status'])
                self.assertEqual('failed', result['proofs']['sharedApiBehavior']['status'])

    def test_report_rejects_old_commit_and_cross_run_same_commit_case(self):
        summary = runtime_summary()
        old_summary = copy.deepcopy(summary)
        old_summary['checkoutCommit'] = '2' * 40
        code, result, _ = self.exercise(old_summary)
        self.assertEqual(1, code)
        self.assertEqual('failed', result['proofs']['runtimeMechanisms']['status'])
        summary['cases'][0]['checkoutCommit'] = '2' * 40
        code, result, _ = self.exercise(summary)
        self.assertEqual(1, code)
        self.assertEqual('failed', result['proofs']['runtimeMechanisms']['status'])
        old_case = real_case()
        old_case['startedAt'] = (NOW - timedelta(minutes=10)).isoformat()
        old_case['finishedAt'] = (NOW - timedelta(minutes=9)).isoformat()
        code, result, _ = self.exercise(runtime_summary(), old_case, require_case=True)
        self.assertEqual(1, code)
        self.assertEqual('failed', result['proofs']['sharedApiBehavior']['status'])
        self.assertIn('timestamps', result['rootbeer']['error'])

    def test_case_manifest_must_bind_commit_lock_and_public_api_artifact(self):
        for override in [{'schemaVersion': 1}, {'production': False}, {'commit': '2' * 40},
                         {'packageLockSha256': 'wrong'}, {'nodeVersion': 'v26.0.0'},
                         {'javaBridgePatch': None}, {'javaBridgePatch': {
                             **load_spec()['javaBridgePatch'], 'patchedSha256': '0' * 64}},
                         {'files': {'dist/android-api.js': 'b' * 64}}]:
            with self.subTest(override=override):
                code, result, _ = self.exercise(runtime_summary(), real_case(), require_case=True,
                                                manifest_override=override)
                self.assertEqual(1, code)
                self.assertEqual('passed', result['proofs']['runtimeMechanisms']['status'])
                self.assertIn('production manifest', result['rootbeer']['error'])

    def test_base_only_local_report_does_not_claim_shared_api_behavior(self):
        for abi in TARGETS:
            with self.subTest(abi=abi):
                code, result, markdown = self.exercise(runtime_summary(abi), abi=abi, image=True)
                self.assertEqual(0, code)
                self.assertNotIn('rootbeer', result)
                self.assertNotIn('emulatorCleanup', result)
                self.assertEqual('passed', result['proofs']['runtimeMechanisms']['status'])
                self.assertEqual({'status': 'not-requested', 'resultPath': None, 'apiAgentSha256': None},
                                 result['proofs']['sharedApiBehavior'])
                self.assertEqual(f'Image ABI={abi}', result['systemImage'])
                self.assertEqual(f'system-images;android-33;default;{abi}', result['systemImagePackage'])
                self.assertIn('runtime mechanisms only', markdown)

    def test_invalid_old_or_mixed_runtime_summary_still_produces_failed_report(self):
        valid = runtime_summary('arm64-v8a')
        variants = ['{broken', [], {'status': 'passed'}, {'status': 'passed', 'cases': [None]},
                    {**valid, 'schemaVersion': 1}, {**valid, 'requestedAbi': 'x86_64'},
                    {**valid, 'toolchainLock': load_spec()}]
        for field, value in [('host', []), ('abi', 'x86_64'), ('schemaVersion', 1),
                             ('processArch', 'x64'), ('serverSha256', 'wrong'),
                             ('javaBridgePatch', None), ('javaBridgePatch', {
                                 **load_spec()['javaBridgePatch'], 'metadataSha256': '0' * 64})]:
            item = copy.deepcopy(valid)
            item['cases'][0][field] = value
            variants.append(item)
        for variant in variants:
            with self.subTest(variant=variant):
                code, result, _ = self.exercise(variant, abi='arm64-v8a')
                self.assertEqual(1, code)
                self.assertEqual('failed', result['status'])
                self.assertEqual('failed', result['proofs']['runtimeMechanisms']['status'])

    def test_case_success_cannot_hide_failed_base_initialization_or_cleanup_steps(self):
        for failure in ['base', 'setup', 'cleanup']:
            with self.subTest(failure=failure):
                summary = runtime_summary()
                summary['cases'][0]['status'] = 'failed' if failure == 'base' else 'passed'
                code, result, _ = self.exercise(summary, real_case(), require_case=True,
                    steps={failure: {'outcome': 'failure'}} if failure != 'base' else {})
                self.assertEqual(1, code)
                self.assertEqual('failed', result['status'])
                self.assertEqual('failed' if failure == 'base' else 'passed', result['proofs']['runtimeMechanisms']['status'])
                self.assertEqual('passed', result['proofs']['sharedApiBehavior']['status'])

    def test_required_emulator_cleanup_is_independent_of_behavior_proofs(self):
        good = {'schemaVersion': 1, 'status': 'passed', 'owned': True,
                'actions': [{'action': 'emulator.stop', 'passed': True}], 'errors': [],
                'finishedAt': '2026-10-20T00:00:00Z'}
        variants = [None, '{broken', [], {**good, 'status': 'failed'},
                    {**good, 'actions': [{'action': 'emulator.stop', 'passed': False}]},
                    {**good, 'errors': ['remaining owned process']}, good]
        for variant in variants:
            with self.subTest(variant=variant):
                code, result, _ = self.exercise(runtime_summary(), real_case(), require_case=True,
                                                cleanup=variant, require_cleanup=True)
                self.assertEqual(0 if variant == good else 1, code)
                self.assertEqual('passed', result['proofs']['runtimeMechanisms']['status'])
                self.assertEqual('passed', result['proofs']['sharedApiBehavior']['status'])
                self.assertEqual('missing' if variant is None else 'passed' if variant == good else 'failed',
                                 result['emulatorCleanup']['status'])


if __name__ == '__main__':
    unittest.main()
