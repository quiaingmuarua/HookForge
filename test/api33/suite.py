#!/usr/bin/env python3
"""Run both hosts and both launch modes, retaining every case's evidence."""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

from prepare import ROOT, HERE, TARGETS, check_case_target, checkout_commit, load_spec, write_json


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--abi', choices=TARGETS, default='x86_64')
    parser.add_argument('--toolchain', type=Path, default=ROOT / '.runtime/frida-api33/toolchain.json')
    parser.add_argument('--apk', type=Path, required=True)
    parser.add_argument('--adb', default=shutil.which('adb'))
    parser.add_argument('--serial', default=os.environ.get('ANDROID_SERIAL', 'emulator-5554'))
    parser.add_argument('--production-manifest', type=Path, default=ROOT / '.runtime/frida-api33/production-manifest.json')
    parser.add_argument('--timeout', type=float, default=90)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    out = args.output.resolve()
    out.mkdir(parents=True, exist_ok=True)
    if (out / 'summary.json').exists():
        parser.error(f'Refusing to overwrite previous results: {out}')
    summary = {'schemaVersion': 3, 'requestedAbi': args.abi, 'status': 'failed', 'stage': 'preflight',
               'startedAt': datetime.now(timezone.utc).isoformat(), 'cases': []}
    try:
        spec = load_spec(abi=args.abi)
        summary['toolchainLock'] = spec
        summary['checkoutCommit'] = checkout_commit()
        tools = json.loads(args.toolchain.read_text(encoding='utf-8'))
        if (tools.get('schemaVersion') != 2 or tools.get('status') != 'passed'
                or tools.get('requestedAbi') != args.abi or tools.get('lock') != spec
                or tools.get('javaBridgePatch') != spec['javaBridgePatch']
                or tools.get('serverSha256') != spec['serverSha256']):
            raise ValueError('Toolchain preparation schema, ABI, Java bridge patch or lock differs from this checkout/target')
        if not args.adb or not args.apk.is_file():
            raise FileNotFoundError('A working adb and built detect-env APK are required')
        summary['stage'] = 'cases'
        for host in ['python', 'node']:
            for mode in ['attach', 'spawn']:
                name = f'{host}-{mode}'
                command = [tools['python'], '-X', 'utf8', str(HERE / 'run.py'), '--host', host, '--mode', mode,
                           '--abi', args.abi,
                           '--adb', args.adb, '--serial', args.serial, '--node', tools['node'],
                           '--apk', str(args.apk.resolve()), '--server', tools['server'],
                           '--production-manifest', str(args.production_manifest.resolve()),
                           '--timeout', str(args.timeout), '--output', str(out / name)]
                case = {'name': name, 'host': host, 'mode': mode, 'status': 'failed', 'command': command}
                with (out / f'{name}.log').open('w', encoding='utf-8') as log:
                    try:
                        code = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT,
                                              timeout=args.timeout * 4 + 60).returncode
                        case['exitCode'] = code
                        result_path = out / name / 'result.json'
                        result = json.loads(result_path.read_text(encoding='utf-8'))
                        case['stage'] = result.get('stage')
                        case['schemaVersion'] = result.get('schemaVersion')
                        case['errors'] = result.get('errors', [])
                        case['resultPath'] = str(result_path)
                        case['requestedAbi'] = result.get('requestedAbi')
                        case['abi'] = result.get('checks', {}).get('device', {}).get('abi')
                        case['sdk'] = result.get('checks', {}).get('device', {}).get('sdk')
                        case['processArch'] = result.get('processArch')
                        case['serverSha256'] = result.get('server', {}).get('sha256')
                        case['javaBridgePatch'] = result.get('javaBridgePatch')
                        case['checkoutCommit'] = result.get('host', {}).get('checkoutCommit')
                        if code == 0 and result.get('status') == 'passed':
                            check_case_target(result, spec)
                            if result.get('hostType') != host or result.get('mode') != mode:
                                raise ValueError('Runtime case host/mode does not match the invocation')
                            if case['checkoutCommit'] != summary['checkoutCommit']:
                                raise ValueError('Runtime case commit does not match this checkout')
                            case['status'] = 'passed'
                    except subprocess.TimeoutExpired:
                        case['error'] = 'Case exceeded its overall timeout'
                    except (OSError, ValueError, KeyError, TypeError, AttributeError) as exc:
                        case['error'] = f'Invalid runtime case evidence: {exc}'
                summary['cases'].append(case)
                write_json(out / 'summary.json', summary)
                print(f"{name}: {case['status']}", flush=True)
        if len(summary['cases']) == 4 and all(case['status'] == 'passed' for case in summary['cases']):
            summary['status'] = 'passed'
            summary['stage'] = 'complete'
    except Exception as exc:
        summary['error'] = f'{type(exc).__name__}: {exc}'
        print(summary['error'], file=sys.stderr)
    finally:
        summary['finishedAt'] = datetime.now(timezone.utc).isoformat()
        write_json(out / 'summary.json', summary)
    return 0 if summary['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
