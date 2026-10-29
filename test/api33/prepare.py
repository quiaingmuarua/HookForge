#!/usr/bin/env python3
"""Prepare/check the lockfile-matched Python client and Android server."""
from __future__ import annotations

import argparse
import hashlib
import json
import lzma
import os
from pathlib import Path
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[2]
HERE = Path(__file__).resolve().parent
# Android ABI, Frida release asset architecture, Process.arch, ELF e_machine.
TARGETS = {'x86_64': ('x86_64', 'x64', 62), 'arm64-v8a': ('arm64', 'arm64', 183)}
JAVA_BRIDGE_PATCH = 'patches/frida-java-bridge-7.0.13.patch.json'


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def checkout_commit() -> str:
    value = subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'],
                                    text=True, timeout=30).strip()
    if len(value) != 40 or any(character not in '0123456789abcdef' for character in value):
        raise ValueError('Could not determine the current checkout commit')
    return value


def java_bridge_patch_spec(root: Path, packages: dict) -> dict:
    """Read expected provenance without requiring a successful npm installation."""
    metadata = root / JAVA_BRIDGE_PATCH
    patch = json.loads(metadata.read_text(encoding='utf-8'))
    locked = packages['node_modules/frida-java-bridge']
    if (not isinstance(patch, dict) or patch.get('schemaVersion') != 1
            or patch.get('id') != 'frida-java-bridge-7.0.13-art-initial-sync'
            or patch.get('packageName') != 'frida-java-bridge'
            or patch.get('packageVersion') != '7.0.13'
            or patch.get('targetFile') != 'lib/android.js'
            or locked.get('version') != patch['packageVersion']
            or locked.get('resolved') != patch.get('sourceTarball')
            or locked.get('integrity') != patch.get('sourceIntegrity')
            or not isinstance(patch.get('sourceTarball'), str)
            or not isinstance(patch.get('sourceIntegrity'), str)):
        raise ValueError('Java bridge patch metadata differs from the reviewed package/lock')
    for field in ['originalSha256', 'patchedSha256']:
        value = patch.get(field)
        if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
            raise ValueError(f'Invalid Java bridge patch {field}')
    return {key: patch[key] for key in
            ['id', 'packageName', 'packageVersion', 'originalSha256', 'patchedSha256']} | {
                'metadataSha256': sha256(metadata)}


def load_spec(root: Path = ROOT, lock: Path = HERE / 'toolchain.lock.json',
              abi: str = 'x86_64') -> dict:
    packages = json.loads((root / 'package-lock.json').read_text(encoding='utf-8'))['packages']
    document = json.loads(lock.read_text(encoding='utf-8'))
    if not isinstance(document, dict) or document.get('schemaVersion') != 2:
        raise ValueError('Frida toolchain lock requires schemaVersion 2; no legacy ABI fallback')
    if abi not in TARGETS:
        raise ValueError(f'Unsupported Android ABI: {abi}')
    version = packages['node_modules/frida']['version']
    if document.get('fridaVersion') != version:
        raise ValueError(f"Server checksum lock needs updating: npm={version}, server lock={document.get('fridaVersion')}")
    targets = document.get('targets')
    if not isinstance(targets, dict) or set(targets) != set(TARGETS):
        raise ValueError('Frida toolchain lock must declare exactly x86_64 and arm64-v8a targets')
    for target_abi, (server_arch, process_arch, _) in TARGETS.items():
        target = targets[target_abi]
        if (not isinstance(target, dict)
                or set(target) != {'serverArch', 'processArch', 'serverSha256', 'serverArchiveSha256'}
                or (target.get('serverArch'), target.get('processArch')) != (server_arch, process_arch)):
            raise ValueError(f'Invalid serverArch/processArch mapping for {target_abi}')
        for field in ['serverSha256', 'serverArchiveSha256']:
            value = target.get(field)
            if not isinstance(value, str) or len(value) != 64 or any(c not in '0123456789abcdef' for c in value):
                raise ValueError(f'Invalid {field} for {target_abi}')
    return {'schemaVersion': 2, 'fridaVersion': version, 'abi': abi, **targets[abi],
            'nodeVersion': (root / '.node-version').read_text(encoding='utf-8').strip(),
            'javaBridgeVersion': packages['node_modules/frida-java-bridge']['version'],
            'javaBridgePatch': java_bridge_patch_spec(root, packages)}


def check_java_bridge(root: Path, spec: dict) -> dict:
    """Require the reviewed patched bytes, even when the npm version is unchanged."""
    expected = spec['javaBridgePatch']
    package_root = root / 'node_modules/frida-java-bridge'
    installed = json.loads((package_root / 'package.json').read_text(encoding='utf-8'))
    if (installed.get('name') != expected['packageName']
            or installed.get('version') != expected['packageVersion']):
        raise ValueError('Installed Java bridge differs from the reviewed package/lock; run npm ci')
    target = package_root / 'lib/android.js'
    if target.is_symlink() or not target.is_file():
        raise ValueError('Java bridge patch target must be a regular installed file')
    actual = sha256(target)
    if actual != expected['patchedSha256']:
        raise ValueError(f"Java bridge patched source checksum mismatch: expected={expected['patchedSha256']}, actual={actual}; run npm ci with lifecycle scripts enabled")
    return dict(expected)


def check_client(version: str, spec: dict) -> None:
    if version != spec['fridaVersion']:
        raise ValueError(f"Client/lock mismatch: client={version}, lock={spec['fridaVersion']}")


def check_server(path: Path, spec: dict) -> None:
    if not path.is_file():
        raise FileNotFoundError(f'frida-server is missing: {path}')
    actual = sha256(path)
    if actual != spec['serverSha256']:
        raise ValueError(f"Server checksum mismatch: expected={spec['serverSha256']}, actual={actual}")


def check_device(api: str, abi: str, expected_abi: str = 'x86_64') -> None:
    if expected_abi not in TARGETS:
        raise ValueError(f'Unsupported Android ABI: {expected_abi}')
    if api != '33' or abi != expected_abi:
        raise ValueError(f'Expected API 33 {expected_abi} emulator, got API {api} {abi}')


def check_process_arch(actual: str, spec: dict) -> None:
    if actual != spec['processArch']:
        raise ValueError(f"Process.arch mismatch for {spec['abi']}: expected={spec['processArch']}, actual={actual}")


def check_apk(path: Path, abi: str) -> dict:
    """Require the actual JNI library for this ABI, including its ELF header."""
    if abi not in TARGETS:
        raise ValueError(f'Unsupported Android ABI: {abi}')
    library = f'lib/{abi}/libdetect_sample.so'
    with zipfile.ZipFile(path) as apk:
        names = apk.namelist()
        if names.count(library) != 1:
            raise ValueError(f'APK must contain exactly one {library}: {path}')
        with apk.open(library) as stream:
            header = stream.read(20)
    if len(header) < 20 or header[:6] != b'\x7fELF\x02\x01':
        raise ValueError(f'APK {library} is not a little-endian ELF64 library')
    machine = int.from_bytes(header[18:20], 'little')
    if machine != TARGETS[abi][2]:
        raise ValueError(f'APK {library} ELF architecture does not match {abi}: {machine}')
    return {'abi': abi, 'library': library, 'elfMachine': machine,
            'nativeAbis': sorted({name.split('/')[1] for name in names
                                  if name.startswith('lib/') and name.endswith('.so') and len(name.split('/')) == 3})}


def check_case_target(result: dict, spec: dict) -> None:
    """Accept only new evidence carrying the observed device and process ABI."""
    if result.get('schemaVersion') != 3 or result.get('requestedAbi') != spec['abi']:
        raise ValueError('Runtime case schema/ABI differs from the requested target')
    if result.get('toolchainLock') != spec:
        raise ValueError('Runtime case toolchain lock differs from this checkout/target')
    if result.get('javaBridgePatch') != spec['javaBridgePatch']:
        raise ValueError('Runtime case lacks matching installed Java bridge patch evidence')
    device = result.get('checks', {}).get('device', {})
    check_device(str(device.get('sdk')), device.get('abi'), spec['abi'])
    check_process_arch(result.get('processArch'), spec)
    if result.get('installedApk', {}).get('native', {}).get('abi') != spec['abi']:
        raise ValueError('Runtime case lacks installed APK ABI evidence')
    if result.get('server', {}).get('sha256') != spec['serverSha256']:
        raise ValueError('Runtime case server checksum differs from the requested target')


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + '\n', encoding='utf-8')


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--abi', choices=TARGETS, default='x86_64')
    parser.add_argument('--tools-root', type=Path, default=ROOT / '.runtime/toolchain/python')
    parser.add_argument('--python', type=Path, help='Use this existing interpreter instead of creating a venv')
    parser.add_argument('--node', default=shutil.which('node'))
    parser.add_argument('--server', type=Path, help='Verify this server instead of downloading it')
    parser.add_argument('--output', type=Path, default=ROOT / '.runtime/frida-api33/toolchain.json')
    parser.add_argument('--check-only', action='store_true')
    args = parser.parse_args()
    args.tools_root = args.tools_root.resolve()
    result = {'schemaVersion': 2, 'requestedAbi': args.abi, 'status': 'failed', 'stage': 'lock'}

    def command(argv: list) -> str:
        proc = subprocess.run([str(x) for x in argv], cwd=HERE, capture_output=True, text=True,
                              encoding='utf-8', errors='replace', timeout=180)
        if proc.returncode:
            raise RuntimeError(f'Command failed: {argv}\n{proc.stdout}\n{proc.stderr}')
        return proc.stdout.strip()

    try:
        spec = load_spec(abi=args.abi)
        result['lock'] = spec
        result['stage'] = 'node'
        if not args.node:
            raise FileNotFoundError('Node is missing; install the version in frida/.node-version')
        node = str(Path(args.node).resolve())
        node_version = command([node, '--version']).removeprefix('v')
        if node_version != spec['nodeVersion']:
            raise ValueError(f"Node version mismatch: expected={spec['nodeVersion']}, actual={node_version}")
        installed = json.loads((ROOT / 'node_modules/frida/package.json').read_text(encoding='utf-8'))['version']
        check_client(installed, spec)
        result['javaBridgePatch'] = check_java_bridge(ROOT, spec)
        result['node'] = node
        result['stage'] = 'python'
        python = args.python or args.tools_root / 'venv' / ('Scripts/python.exe' if os.name == 'nt' else 'bin/python')
        # Keep the venv entrypoint: resolving its symlink selects the base Python.
        python = python.absolute()
        if not python.is_file():
            if args.check_only or args.python:
                raise FileNotFoundError(f'Python interpreter is missing: {python}')
            command([sys.executable, '-m', 'venv', args.tools_root / 'venv'])
        probe = subprocess.run([str(python), '-c', 'import frida; print(frida.__version__)'], cwd=HERE,
                               capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=30)
        if probe.returncode or probe.stdout.strip() != spec['fridaVersion']:
            if args.check_only:
                raise ValueError(f"Python Frida is missing or mismatched: {probe.stdout.strip() or probe.stderr.strip()}")
            if subprocess.run([str(python), '-m', 'pip', '--version'], cwd=HERE, capture_output=True).returncode:
                command([python, '-m', 'ensurepip', '--upgrade'])
            command([python, '-m', 'pip', '--disable-pip-version-check', 'install', f"frida=={spec['fridaVersion']}"])
        check_client(command([python, '-c', 'import frida; print(frida.__version__)']), spec)
        result['python'] = str(python)
        result['pythonVersion'] = command([python, '--version'])
        result['stage'] = 'server'
        server = (args.server or args.tools_root / f"frida-server-{spec['fridaVersion']}-android-{spec['serverArch']}").resolve()
        if not server.is_file():
            if args.check_only or args.server:
                raise FileNotFoundError(f'frida-server is missing: {server}')
            server.parent.mkdir(parents=True, exist_ok=True)
            archive = server.with_name(server.name + '.xz')
            if not archive.is_file() or sha256(archive) != spec['serverArchiveSha256']:
                url = f"https://github.com/frida/frida/releases/download/{spec['fridaVersion']}/{server.name}.xz"
                temporary = archive.with_suffix('.download')
                try:
                    with urllib.request.urlopen(url, timeout=30) as response, temporary.open('wb') as stream:
                        shutil.copyfileobj(response, stream)
                    if sha256(temporary) != spec['serverArchiveSha256']:
                        raise ValueError('Downloaded server archive checksum mismatch')
                    temporary.replace(archive)
                finally:
                    temporary.unlink(missing_ok=True)
            temporary = server.with_name(server.name + '.unpacking')
            try:
                with lzma.open(archive, 'rb') as source, temporary.open('wb') as target:
                    shutil.copyfileobj(source, target)
                check_server(temporary, spec)
                temporary.replace(server)
            finally:
                temporary.unlink(missing_ok=True)
        check_server(server, spec)
        if not args.check_only:
            server.chmod(0o755)
        result['server'] = str(server)
        result['serverSha256'] = spec['serverSha256']
        result['status'] = 'passed'
        result['stage'] = 'complete'
    except Exception as exc:
        result['error'] = f'{type(exc).__name__}: {exc}'
        print(result['error'], file=sys.stderr)
    write_json(args.output.resolve(), result)
    print(f"TOOLCHAIN {result['status']}: {args.output.resolve()}")
    return 0 if result['status'] == 'passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
