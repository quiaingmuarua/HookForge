#!/usr/bin/env python3
"""Verify real Native/RPC/Java behavior in detect-env on an API 33 emulator."""
from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import traceback
from datetime import datetime, timedelta, timezone
from pathlib import Path

from prepare import TARGETS, check_apk, check_client, check_device, check_java_bridge, check_process_arch, check_server, load_spec

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
PACKAGE = 'com.detect.app.sample'
LOCAL_TIMEZONE = timezone(timedelta(hours=8))


def digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--abi', choices=TARGETS, default='x86_64')
    parser.add_argument('--serial', default=os.environ.get('ANDROID_SERIAL'))
    parser.add_argument('--adb', default=shutil.which('adb'))
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--apk', type=Path, help='Install this detect-env lab APK with adb install -r -t')
    parser.add_argument('--server', type=Path, help='Push and start a matching frida-server if none is running')
    parser.add_argument('--mode', choices=['attach', 'spawn'], default='attach')
    parser.add_argument('--host', choices=['python', 'node'], default='python')
    parser.add_argument('--native-agent', type=Path, default=HERE / 'native.js',
                        help='Use a custom probe for controlled negative tests (Python host only)')
    parser.add_argument('--production-manifest', type=Path,
                        default=ROOT / '.runtime/frida-api33/production-manifest.json')
    parser.add_argument('--runtime', choices=['qjs', 'v8'], default='qjs')
    parser.add_argument('--timeout', type=float, default=90)
    parser.add_argument('--output', type=Path)
    args = parser.parse_args()
    now = datetime.now(LOCAL_TIMEZONE)
    out = (args.output or ROOT / '.runtime/frida-api33/results' / now.strftime('%Y%m%d-%H%M%S')).resolve()
    out.mkdir(parents=True, exist_ok=False)
    result = {'schemaVersion': 3, 'requestedAbi': args.abi, 'startedAt': now.isoformat(), 'status': 'failed',
              'hostType': args.host, 'mode': args.mode, 'runtime': args.runtime,
              'stage': 'preflight', 'checks': {}, 'errors': [], 'cleanup': []}
    messages = []
    scripts = []
    session = None
    port = None
    pid = None
    transport = None

    def record(name, value):
        result['checks'][name] = value
        print(f'{name}: {json.dumps(value, ensure_ascii=False)}', flush=True)

    def check(condition, description):
        if not condition:
            raise AssertionError(description)

    def command(argv, timeout=None):
        started = time.monotonic()
        try:
            proc = subprocess.run([str(x) for x in argv], text=True, encoding='utf-8', errors='replace', capture_output=True,
                                  timeout=timeout or args.timeout)
        except subprocess.TimeoutExpired as exc:
            with (out / 'commands.jsonl').open('a', encoding='utf-8') as stream:
                stream.write(json.dumps({'command': [str(x) for x in argv], 'returnCode': None,
                    'timedOut': True, 'durationMs': round((time.monotonic() - started) * 1000)},
                    ensure_ascii=False) + '\n')
            raise
        with (out / 'commands.jsonl').open('a', encoding='utf-8') as stream:
            stream.write(json.dumps({'command': [str(x) for x in argv], 'returnCode': proc.returncode,
                                     'stdout': proc.stdout, 'stderr': proc.stderr,
                                     'durationMs': round((time.monotonic() - started) * 1000)},
                                     ensure_ascii=False) + '\n')
        if proc.returncode:
            raise RuntimeError(f'Command failed ({proc.returncode}): {argv}\n{proc.stdout}\n{proc.stderr}')
        return proc.stdout.strip()

    def adb(*argv):
        return command([args.adb, '-s', args.serial, *argv])

    def verify_target_process(expected_pid, description):
        check(type(expected_pid) is int and expected_pid > 0, 'Invalid target PID')
        # NativeActivity may briefly fork a helper with the same process name.
        # Verify the original process instead of requiring pidof to be singular.
        matching_pids = adb('shell', 'pidof', PACKAGE).split()
        check(str(expected_pid) in matching_pids, description)
        cmdline = adb('shell', 'cat', f'/proc/{expected_pid}/cmdline').split('\0', 1)[0]
        check(cmdline == PACKAGE, 'Target PID belongs to a different process')
        record('targetProcess', {'pid': expected_pid, 'matchingPids': matching_pids, 'cmdline': cmdline})

    def bounded(fn):
        cancellable = frida.Cancellable()
        timer = threading.Timer(args.timeout, cancellable.cancel)
        timer.daemon = True
        timer.start()
        try:
            with cancellable:
                return fn()
        finally:
            timer.cancel()

    def rpc_call(script, method, *values):
        return bounded(lambda: getattr(script.exports_sync, method)(*values))

    def load_agent(name, source):
        script = bounded(lambda: session.create_script(source, name=name, runtime=args.runtime))
        scripts.append((name, script))
        def on_message(message, data):
            event = {'agent': name, 'message': message,
                     'timestamp': datetime.now(timezone.utc).isoformat(),
                     'dataBytes': len(data) if data else 0}
            messages.append(event)
            with (out / 'messages.jsonl').open('a', encoding='utf-8') as stream:
                stream.write(json.dumps(event, ensure_ascii=False) + '\n')
            if message['type'] == 'error':
                print(f'AGENT ERROR: {message}', file=sys.stderr, flush=True)
        script.on('message', on_message)
        bounded(script.load)
        return script

    try:
        spec = load_spec(abi=args.abi)
        frida = importlib.import_module('frida')
        check_client(frida.__version__, spec)
        check(args.node is not None, 'Node is missing: install frida/.node-version')
        check(command([args.node, '--version']) == 'v' + spec['nodeVersion'], 'Node version differs from frida/.node-version')
        result['javaBridgePatch'] = check_java_bridge(ROOT, spec)
        if args.server:
            check_server(args.server, spec)
        result['toolchainLock'] = spec
        check(args.adb is not None, 'adb is missing: add SDK platform-tools to PATH or use --adb')
        if not args.serial:
            devices = command([args.adb, 'devices']).splitlines()[1:]
            serials = [line.split()[0] for line in devices if line.endswith('\tdevice')]
            check(len(serials) == 1, 'Select exactly one emulator with --serial or ANDROID_SERIAL')
            args.serial = serials[0]
        check(args.serial.startswith('emulator-'), 'This runner is scoped to a disposable Android emulator')
        api = adb('shell', 'getprop', 'ro.build.version.sdk')
        abi = adb('shell', 'getprop', 'ro.product.cpu.abi')
        check_device(api, abi, args.abi)
        check(adb('shell', 'getprop', 'sys.boot_completed') == '1', 'Emulator has not finished booting')
        record('device', {'serial': args.serial, 'sdk': int(api),
                         'abi': abi,
                         'release': adb('shell', 'getprop', 'ro.build.version.release'),
                         'fingerprint': adb('shell', 'getprop', 'ro.build.fingerprint')})
        result['host'] = {'frida': frida.__version__, 'python': sys.version.split()[0],
                          'node': command([args.node, '--version']),
                          'checkoutCommit': command(['git', '-C', ROOT, 'rev-parse', 'HEAD'])}
        result['stage'] = 'apk'
        if args.apk:
            check(args.apk.is_file(), f'APK missing: {args.apk}')
            result['apk'] = {'path': str(args.apk.resolve()), 'sha256': digest(args.apk),
                             'native': check_apk(args.apk, args.abi)}
            adb('install', '-r', '-t', args.apk)
        package_path = adb('shell', 'pm', 'path', PACKAGE)
        check(package_path.startswith('package:'), 'detect-env is not installed')
        installed_path = package_path.splitlines()[0].removeprefix('package:')
        installed_apk = out / 'installed-detect-env.apk'
        adb('pull', installed_path, installed_apk)
        installed_sha = digest(installed_apk)
        result['installedApk'] = {'devicePath': installed_path, 'sha256': installed_sha,
                                 'native': check_apk(installed_apk, args.abi)}
        if args.apk:
            check(installed_sha == result['apk']['sha256'], 'Installed APK does not match supplied APK')
        result['stage'] = 'server'
        if args.server:
            check(args.server.is_file(), f'frida-server missing: {args.server}')
            adb('root')
            adb('wait-for-device')
            check('uid=0' in adb('shell', 'id'), 'A rootable AOSP emulator is required')
            server_path = '/data/local/tmp/agentforge-frida-server'
            running = adb('shell', 'pidof agentforge-frida-server || true')
            if not running:
                adb('push', args.server, server_path)
                adb('shell', 'chmod', '755', server_path)
            version = adb('shell', server_path, '--version')
            check(version == frida.__version__, f'Client/server mismatch: {frida.__version__} / {version}')
            server_sha = adb('shell', 'sha256sum', server_path).split()[0]
            check(server_sha == digest(args.server), 'Device frida-server does not match supplied server')
            result['server'] = {'version': version, 'sha256': server_sha}
            if not running:
                # Detach every standard fd; -D alone may keep the ADB shell session open.
                adb('shell', f'nohup {server_path} </dev/null '
                    '> /data/local/tmp/agentforge-frida-server.log 2>&1 &')
        else:
            server_path = '/data/local/tmp/agentforge-frida-server'
            version = adb('shell', server_path, '--version')
            check_client(version, spec)
            server_sha = adb('shell', 'sha256sum', server_path).split()[0]
            check(server_sha == spec['serverSha256'], 'Running server checksum differs from toolchain.lock.json')
            result['server'] = {'version': version, 'sha256': server_sha}
        result['stage'] = 'connect'
        port = adb('forward', 'tcp:0', 'tcp:27042')
        if args.host == 'python':
            transport = frida.get_device_manager().add_remote_device(f'127.0.0.1:{port}')
            deadline = time.monotonic() + args.timeout
            startup_retries = 0
            while True:
                try:
                    bounded(transport.enumerate_processes)
                    break
                except (frida.ServerNotRunningError, frida.TransportError):
                    if time.monotonic() >= deadline:
                        raise
                    startup_retries += 1
                    time.sleep(0.5)
            result['startupRetries'] = startup_retries
        # The production Node CLI owns its connection. A second Python peer can
        # outlive Node teardown and race server-side session cleanup.

        result['stage'] = 'hook-tests'
        if args.host == 'node':
            result['stage'] = 'node-production'
            command([args.node, ROOT / 'scripts/production-artifact.mjs', 'verify', args.production_manifest])
            result['production'] = json.loads(args.production_manifest.read_text(encoding='utf-8'))
            adb('shell', 'am', 'force-stop', PACKAGE)
            if args.mode == 'attach':
                adb('shell', 'am', 'start', '-W', '-n', f'{PACKAGE}/.DetectEnvMainActivity')
            node_result = out / 'node-result.json'
            cli = [args.node, ROOT / 'dist/node-cli/run.js', '--smoke',
                   '--timeout-ms', str(round(args.timeout * 1000)),
                   '--device', f'remote:127.0.0.1:{port}',
                   '--config', HERE / 'node-target.json',
                   '--bundle', ROOT / 'dist/bundle.js',
                   '--require-module', 'android/runtime-bypass',
                   '--result', node_result]
            if args.mode == 'spawn':
                cli.extend(['--spawn', '--verbose'])
            # Frida may enumerate a localized process label instead of its package ID.
            target = PACKAGE if args.mode == 'spawn' else adb('shell', 'pidof', PACKAGE)
            check(args.mode == 'spawn' or target.isdigit(), 'Expected one attachable detect-env PID')
            cli.append(target)
            command(cli, timeout=args.timeout + 30)
            node_outcome = json.loads(node_result.read_text(encoding='utf-8'))
            check(node_outcome['status'] == 'passed' and node_outcome['ready'], 'Node loader did not become ready')
            check(node_outcome['modules'].get('android/runtime-bypass') == 'activated', 'Required Node module did not activate')
            check(not node_outcome['errors'], 'Node host reported an error')
            check(all(item['status'] == 'passed' for item in node_outcome['cleanup']), 'Node cleanup failed')
            ready = [message['payload'] for message in node_outcome.get('messages', [])
                     if message.get('type') == 'send' and isinstance(message.get('payload'), dict)
                     and message['payload'].get('type') == 'loader-ready']
            check(len(ready) == 1, 'Expected exactly one Node loader-ready environment')
            environment = ready[0].get('stats', {}).get('environment', {})
            record('nodeRuntime', environment)
            result['processArch'] = environment.get('arch')
            check_process_arch(result['processArch'], spec)
            check(environment.get('platform') == 'android' and environment.get('appId') == PACKAGE,
                  'Wrong Node target platform or package')
            verify_target_process(node_outcome['pid'], 'Node target exited or restarted')
            record('nodeCli', node_outcome)
        else:
            # Compile the Java bridge explicitly; Frida 17 create_script() has no global Java.
            esbuild = ROOT / 'node_modules/esbuild/bin/esbuild'
            check(esbuild.is_file(), 'Run npm ci in frida/ before this test')
            java_bundle = out / 'java.bundle.js'
            esbuild_command = [args.node, esbuild] if os.name == 'nt' else [esbuild]
            command([*esbuild_command, HERE / 'java.ts', '--bundle', '--format=iife',
                     '--platform=neutral', '--target=es2020', f'--outfile={java_bundle}'])
            for source in [args.native_agent, HERE / 'java.ts', Path(__file__).resolve()]:
                shutil.copy2(source, out / source.name)
            result['sourceHashes'] = {path.name: digest(path) for path in
                                      [args.native_agent, HERE / 'java.ts', Path(__file__).resolve(), java_bundle]}
            bridge_source = ROOT / 'packages/runtime/java-bridge.ts'
            shutil.copy2(bridge_source, out / 'java-bridge-runtime.ts')
            result['sourceHashes']['java-bridge-runtime.ts'] = digest(bridge_source)
            adb('shell', 'am', 'force-stop', PACKAGE)
            if args.mode == 'spawn':
                pid = bounded(lambda: transport.spawn([PACKAGE]))
                session = bounded(lambda: transport.attach(pid))
                native = load_agent('api33-native', args.native_agent.read_text(encoding='utf-8'))
                java = load_agent('api33-java', java_bundle.read_text(encoding='utf-8'))
                bounded(lambda: transport.resume(pid))
            else:
                adb('shell', 'am', 'start', '-W', '-n', f'{PACKAGE}/.DetectEnvMainActivity')
                pid_text = adb('shell', 'pidof', PACKAGE)
                check(pid_text.isdigit(), f'Expected one detect-env process, got {pid_text!r}')
                pid = int(pid_text)
                session = bounded(lambda: transport.attach(pid))
                native = load_agent('api33-native', args.native_agent.read_text(encoding='utf-8'))
                java = load_agent('api33-java', java_bundle.read_text(encoding='utf-8'))
            result['pid'] = pid
            info = rpc_call(native, 'info')
            check(info['pid'] == pid and info['platform'] == 'linux', 'Wrong native process')
            record('nativeRuntime', info)
            result['processArch'] = info.get('arch')
            check_process_arch(result['processArch'], spec)

            payload = {'text': 'API 33 RPC 往返', 'nested': {'numbers': [1, 2, 3], 'ok': True, 'empty': None}}
            echo = rpc_call(native, 'echo', payload)
            check(echo == payload, 'RPC JSON round trip changed the payload')
            total = rpc_call(native, 'asyncadd', 19, 23)
            check(total == 42, f'Async RPC returned {total}')
            error = ''
            try:
                rpc_call(native, 'expectedfailure')
            except frida.core.RPCException as exc:
                error = str(exc)
            check('API33_EXPECTED_RPC_ERROR' in error, 'Expected RPC error did not reach the host')
            record('rpc', {'status': 'passed', 'echo': echo, 'asyncSum': total, 'expectedError': error})

            before = rpc_call(native, 'probe')
            rpc_call(native, 'install')
            during = rpc_call(native, 'probe')
            hits = rpc_call(native, 'remove')
            after = rpc_call(native, 'probe')
            native_passed = (before, during, after, hits) == (0, -1, 0, 1)
            record('nativeHook', {'status': 'passed' if native_passed else 'failed', 'symbol': 'libc.so!access',
                                 'before': before, 'hooked': during, 'restored': after, 'hits': hits})
            check(native_passed, 'Native hook/restore/callback assertion failed')
            java_info = rpc_call(java, 'info')
            check(java_info['javaAvailable'] and java_info['package'] == PACKAGE and java_info['sdk'] == 33,
                  'Wrong Java VM, app, or API level')
            record('javaRuntime', java_info)
            java_error = ''
            try:
                rpc_call(java, 'expectedfailure')
            except frida.core.RPCException as exc:
                java_error = str(exc)
            check('API33_EXPECTED_JAVA_RPC_ERROR' in java_error, 'Java callback error did not reach the RPC host')
            record('javaRpcError', {'status': 'passed', 'expectedError': java_error})
            for prefix, probe, install, remove, expected in [
                ('jniHook', 'probejni', 'installjni', 'removejni', (1, 0, 1, 1)),
                ('javaHook', 'probejava', 'installjava', 'removejava', (True, False, True, 1)),
            ]:
                before = rpc_call(java, probe)
                rpc_call(java, install)
                during = rpc_call(java, probe)
                hits = rpc_call(java, remove)
                after = rpc_call(java, probe)
                passed = (before, during, after, hits) == expected
                record(prefix, {'status': 'passed' if passed else 'failed', 'before': before, 'hooked': during, 'restored': after, 'hits': hits})
                check(passed, f'{prefix} hook/restore/callback assertion failed')
            event_types = [event['message'].get('payload', {}).get('type') for event in messages
                           if event['message']['type'] == 'send']
            for kind in ['native-hook-hit', 'jni-hook-hit', 'java-hook-hit']:
                check(event_types.count(kind) == 1, f'Expected exactly one {kind} message, got {event_types}')
            check(not any(event['message']['type'] == 'error' for event in messages), 'Frida agent emitted an error')
            verify_target_process(pid, 'detect-env exited or restarted during verification')
        result['status'] = 'passed'
        result['stage'] = 'complete'
    except Exception as exc:
        result['errors'].append({'type': type(exc).__name__, 'message': str(exc), 'traceback': traceback.format_exc()})
        print(traceback.format_exc(), file=sys.stderr, flush=True)
    finally:
        node_result = out / 'node-result.json'
        if node_result.exists():
            try:
                node_outcome = json.loads(node_result.read_text(encoding='utf-8'))
                with (out / 'messages.jsonl').open('w', encoding='utf-8') as stream:
                    for message in node_outcome.get('messages', []):
                        stream.write(json.dumps({'agent': 'production-loader', 'message': message}, ensure_ascii=False) + '\n')
            except Exception as exc:
                result['cleanup'].append({'nodeResultError': str(exc)})
        # Restore callbacks even when a middle assertion fails, then detach both scripts.
        for name, script in reversed(scripts):
            try:
                if name == 'api33-java':
                    rpc_call(script, 'removejava')
                    rpc_call(script, 'removejni')
                else:
                    rpc_call(script, 'remove')
                bounded(script.unload)
                result['cleanup'].append({'script': name, 'status': 'unloaded'})
            except Exception as exc:
                result['cleanup'].append({'script': name, 'error': str(exc)})
        if session is not None:
            try:
                bounded(session.detach)
                result['cleanup'].append({'action': 'session.detach', 'status': 'passed'})
            except Exception as exc:
                result['cleanup'].append({'sessionError': str(exc)})
        if transport is not None:
            try:
                bounded(lambda: frida.get_device_manager().remove_remote_device(f'127.0.0.1:{port}'))
                result['cleanup'].append({'action': 'remote.remove', 'status': 'passed'})
            except Exception as exc:
                result['cleanup'].append({'remoteError': str(exc)})
        if port:
            try:
                adb('forward', '--remove', f'tcp:{port}')
                result['cleanup'].append({'action': 'adb.forward.remove', 'status': 'passed'})
            except Exception as exc:
                result['cleanup'].append({'forwardError': str(exc)})
        if args.adb and args.serial:
            try:
                (out / 'logcat.txt').write_text(adb('logcat', '-d', '-t', '800'), encoding='utf-8')
            except Exception as exc:
                result['cleanup'].append({'logcatError': str(exc)})
        if any('error' in item or any(key.endswith('Error') for key in item) for item in result['cleanup']):
            result['status'] = 'failed'
        result['finishedAt'] = datetime.now(LOCAL_TIMEZONE).isoformat()
        (out / 'result.json').write_text(json.dumps(result, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')
        print(f"RESULT {result['status'].upper()}: {out / 'result.json'}", flush=True)
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
