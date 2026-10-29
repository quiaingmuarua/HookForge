#!/usr/bin/env python3
"""Report runtime mechanisms separately from shared API behavior evidence."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import subprocess

from prepare import ROOT, TARGETS, checkout_commit, load_spec, sha256, write_json


def evidence_time(value) -> datetime:
    if not isinstance(value, str):
        raise ValueError('Evidence timestamp is missing')
    parsed = datetime.fromisoformat(value[:-1] + '+00:00' if value.endswith('Z') else value)
    if parsed.tzinfo is None:
        raise ValueError('Evidence timestamp must include a timezone')
    return parsed


def case_evidence(path: Path, spec: dict, commit: str, suite_finished: str) -> dict:
    result = {'status': 'missing', 'resultPath': str(path), 'apiAgentSha256': None}
    if not path.is_file():
        result['error'] = 'Required real-APK case evidence is missing'
        return result
    try:
        case = json.loads(path.read_text(encoding='utf-8'))
        result['apiAgentSha256'] = case.get('apiAgentSha256')
        result['failures'] = case.get('evaluation', {}).get('failures', [])
        manifest = json.loads((path.parent / 'production-manifest.json').read_text(encoding='utf-8'))
        result['javaBridgePatch'] = manifest.get('javaBridgePatch')
        if (manifest.get('schemaVersion') != 2 or manifest.get('production') is not True
                or manifest.get('commit') != commit
                or manifest.get('packageLockSha256') != sha256(ROOT / 'package-lock.json')
                or manifest.get('nodeVersion') != 'v' + spec['nodeVersion']
                or manifest.get('javaBridgePatch') != spec['javaBridgePatch']
                or not isinstance(result['apiAgentSha256'], str)
                or len(result['apiAgentSha256']) != 64
                or manifest.get('files', {}).get('dist/android-api.js') != result['apiAgentSha256']):
            raise ValueError('Case production manifest does not match this checkout/toolchain/API artifact')
        if not (evidence_time(suite_finished) <= evidence_time(case.get('startedAt'))
                <= evidence_time(case.get('finishedAt')) <= datetime.now(timezone.utc)):
            raise ValueError('Case timestamps do not belong to the run after this suite')
        environment = case.get('environment', {})
        if (case.get('schemaVersion') != 3 or case.get('requestedAbi') != spec['abi']
                or environment.get('sdk') != 33 or environment.get('abi') != spec['abi']
                or environment.get('serverArch') != spec['serverArch']
                or environment.get('processArch') != spec['processArch']
                or environment.get('target', {}).get('arch') != spec['processArch']
                or case.get('reuse', {}).get('target', {}).get('arch') != spec['processArch']
                or environment.get('frida') != spec['fridaVersion']
                or environment.get('serverVersion') != spec['fridaVersion']
                or environment.get('serverSha256') != spec['serverSha256']):
            raise ValueError('Case schema, observed ABI/Process.arch or server differs from the requested target')
        if (case.get('evaluation', {}).get('passed') is True
                and case.get('agentSource') == 'production-artifact'
                and case.get('reuse', {}).get('requested') is True):
            result['status'] = 'passed'
        else:
            result['status'] = 'failed'
            result['error'] = 'Case failed or did not verify production-artifact reuse'
    except (OSError, ValueError, AttributeError, TypeError) as exc:
        result['status'] = 'failed'
        result['error'] = f'Invalid case evidence: {exc}'
    return result


def cleanup_evidence(path: Path) -> dict:
    result = {'status': 'missing', 'resultPath': str(path)}
    if not path.is_file():
        result['error'] = 'Required emulator cleanup evidence is missing'
        return result
    try:
        evidence = json.loads(path.read_text(encoding='utf-8'))
        result['evidence'] = evidence
        if (not isinstance(evidence, dict) or evidence.get('schemaVersion') != 1
                or evidence.get('status') != 'passed' or not isinstance(evidence.get('owned'), bool)
                or evidence.get('errors') != [] or not isinstance(evidence.get('actions'), list)
                or not all(isinstance(action, dict) and action.get('passed') is True
                           and not action.get('error') for action in evidence['actions'])):
            raise ValueError('Emulator cleanup did not pass with complete evidence')
        result['status'] = 'passed'
    except (OSError, ValueError, TypeError) as exc:
        result['status'] = 'failed'
        result['error'] = f'Invalid emulator cleanup evidence: {exc}'
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--abi', choices=TARGETS, default='x86_64')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--case-result', type=Path, help='Require RootBeer and detect-env production-artifact proof')
    parser.add_argument('--cleanup-result', type=Path, help='Require successful owned-emulator cleanup evidence')
    args = parser.parse_args()
    root = args.output.resolve()
    root.mkdir(parents=True, exist_ok=True)
    summary_path = root / 'summary.json'
    try:
        summary = json.loads(summary_path.read_text(encoding='utf-8')) if summary_path.exists() else {'status': 'failed', 'stage': 'initialization', 'cases': []}
        if (not isinstance(summary, dict) or not isinstance(summary.get('cases'), list)
                or not all(isinstance(case, dict) for case in summary['cases'])):
            raise ValueError('Runtime summary must contain a cases array of objects')
    except (OSError, ValueError) as exc:
        summary = {'status': 'failed', 'stage': 'summary', 'cases': [], 'error': str(exc)}
    errors = []
    commit = None
    try:
        spec = load_spec(abi=args.abi)
        commit = checkout_commit()
    except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError) as exc:
        spec = None
        errors.append(f'Invalid checkout/toolchain: {exc}')
    try:
        steps = json.loads(os.environ.get('FRIDA_STEP_RESULTS', '{}'))
        if not isinstance(steps, dict) or not all(isinstance(value, dict) for value in steps.values()):
            raise ValueError('Steps must be an object of step results')
    except ValueError as exc:
        steps = {}
        errors.append(f'Invalid workflow step results: {exc}')
    failures = [name for name, value in steps.items() if value.get('outcome') in ['failure', 'cancelled']]
    job_status = os.environ.get('FRIDA_JOB_STATUS', summary.get('status', 'failed'))
    expected = {(host, mode) for host in ['python', 'node'] for mode in ['attach', 'spawn']}
    cases = summary.get('cases', [])
    target_matches = (spec is not None and summary.get('schemaVersion') == 3
                      and summary.get('requestedAbi') == args.abi and summary.get('toolchainLock') == spec
                      and summary.get('checkoutCommit') == commit
                      and all(case.get('schemaVersion') == 3 and case.get('requestedAbi') == args.abi
                              and case.get('abi') == args.abi and case.get('sdk') == 33
                              and case.get('processArch') == spec['processArch']
                              and case.get('checkoutCommit') == commit
                              and case.get('javaBridgePatch') == spec['javaBridgePatch']
                              and case.get('serverSha256') == spec['serverSha256'] for case in cases))
    try:
        if not (evidence_time(summary.get('startedAt')) <= evidence_time(summary.get('finishedAt'))
                <= datetime.now(timezone.utc)):
            raise ValueError('Runtime summary timestamps are not ordered before this report')
    except ValueError as exc:
        target_matches = False
        errors.append(str(exc))
    if not target_matches:
        errors.append('Runtime summary schema, commit, Java bridge patch, observed ABI/Process.arch or server differs from this checkout/target')
    base_passed = (target_matches and summary.get('status') == 'passed' and len(cases) == 4
                   and all(isinstance(case.get(field), str) for case in cases for field in ['host', 'mode', 'status'])
                   and {(case.get('host'), case.get('mode')) for case in cases} == expected
                   and all(case.get('status') == 'passed' for case in cases))
    result = {'schemaVersion': 3, 'requestedAbi': args.abi,
              'status': 'passed' if not errors and not failures and job_status in ['passed', 'success'] and base_passed else 'failed',
              'failedSteps': failures, 'suite': summary, 'runId': os.environ.get('GITHUB_RUN_ID'),
              'runAttempt': os.environ.get('GITHUB_RUN_ATTEMPT'), 'steps': steps, 'errors': errors, 'commit': commit}
    if os.environ.get('CONSUMER_COMMIT'):
        result['consumerCommit'] = os.environ['CONSUMER_COMMIT']
        result['consumerRepository'] = os.environ.get('GITHUB_REPOSITORY')
    shared = {'status': 'not-requested', 'resultPath': None, 'apiAgentSha256': None}
    if args.case_result:
        result['rootbeer'] = case_evidence(args.case_result.resolve(), spec, commit, summary.get('finishedAt')) if spec else {
            'status': 'failed', 'resultPath': str(args.case_result.resolve()), 'apiAgentSha256': None,
            'error': 'Cannot verify case against an invalid toolchain lock'}
        shared = result['rootbeer']
        if shared['status'] != 'passed':
            result['status'] = 'failed'
    result['proofs'] = {
        'runtimeMechanisms': {'status': 'passed' if base_passed else 'failed',
                              'resultPath': str(summary_path)},
        'sharedApiBehavior': {key: shared[key] for key in ['status', 'resultPath', 'apiAgentSha256']},
    }
    if args.cleanup_result:
        result['emulatorCleanup'] = cleanup_evidence(args.cleanup_result.resolve())
        if result['emulatorCleanup']['status'] != 'passed':
            result['status'] = 'failed'
    sdk = Path(os.environ.get('ANDROID_HOME') or os.environ.get('ANDROID_SDK_ROOT') or ROOT / '.runtime/toolchain/android-sdk')
    result['systemImagePackage'] = f'system-images;android-33;default;{args.abi}'
    image = sdk / f'system-images/android-33/default/{args.abi}/source.properties'
    if image.exists():
        result['systemImage'] = image.read_text(encoding='utf-8')
    executable_suffix = '.exe' if os.name == 'nt' else ''
    for name, command in {
        'emulator': [str(sdk / f'emulator/emulator{executable_suffix}'), '-version'],
        'adb': [str(sdk / f'platform-tools/adb{executable_suffix}'), 'version'],
        'devices': [str(sdk / f'platform-tools/adb{executable_suffix}'), 'devices', '-l'],
    }.items():
        try:
            proc = subprocess.run(command, text=True, encoding='utf-8', errors='replace', capture_output=True, timeout=10)
            result[name] = (proc.stdout + proc.stderr).strip()
        except (OSError, subprocess.TimeoutExpired) as exc:
            result[name] = str(exc)
    write_json(root / 'job-result.json', result)
    lines = ['## 运行机制回归 / Runtime mechanisms', '',
             f'Target: API 33 `{args.abi}`.', '',
             f"Result: **{result['proofs']['runtimeMechanisms']['status']}**.",
             f'Evidence: `{summary_path}`.', '',
             'Java/JNI app-method probes test interception, RPC and restoration only; '
             'they do not prove reusable API effects on an original detector.', '',
             '| Host | Mode | Result |', '| --- | --- | --- |']
    for case in summary['cases']:
        lines.append(f"| {case.get('host', 'unknown')} | {case.get('mode', 'unknown')} | {case.get('status', 'failed')} |")
    if not summary['cases']:
        lines.append('| — | — | initialization failed |')
    lines.extend(['', '## 公共 API 行为验证 / Shared API behavior', '',
                  f"Result: **{shared['status']}**."])
    if args.case_result:
        case = result['rootbeer']
        lines.extend([f"Evidence: `{case['resultPath']}`.",
                      f"Public API SHA256: `{case['apiAgentSha256'] or 'missing'}`."])
        if case.get('error'):
            lines.append(case['error'])
        case_report = args.case_result.parent / 'report.md'
        if case_report.is_file():
            lines.extend(['', case_report.read_text(encoding='utf-8')])
    else:
        lines.extend(['', 'This local run verifies runtime mechanisms only. '
                      'Shared API behavior was not requested; use --case-result for the real-APK proof.'])
    if args.cleanup_result:
        lines.extend(['', f"Emulator cleanup: **{result['emulatorCleanup']['status']}**.",
                      f"Evidence: `{result['emulatorCleanup']['resultPath']}`."])
    if errors:
        lines.extend(['', *errors])
    lines.append(f"\nFrida API 33: **{result['status']}**. Failed steps: {', '.join(failures) or 'none'}.")
    report = '\n'.join(lines) + '\n'
    (root / 'summary.md').write_text(report, encoding='utf-8')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with Path(os.environ['GITHUB_STEP_SUMMARY']).open('a', encoding='utf-8') as stream:
            stream.write(report)
    print(report)
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
