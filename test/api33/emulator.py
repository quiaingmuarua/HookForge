#!/usr/bin/env python3
"""Own one isolated API 33 emulator and record startup/cleanup evidence."""
from __future__ import annotations

import argparse
from contextlib import contextmanager
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import platform
import re
import shlex
import shutil
import signal
import socket
import subprocess
import sys
import time
import uuid

ABIS = ('x86_64', 'arm64-v8a')
BOOT_TIMEOUT = 180


@contextmanager
def defer_interrupts():
    """Persist newly acquired resource ownership before handling a termination signal."""
    pending = []
    previous = {number: signal.signal(number, lambda number, _frame: pending.append(number))
                for number in [signal.SIGINT, signal.SIGTERM]}
    try:
        yield
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
        if pending:
            raise InterruptedError(f'Emulator lifecycle interrupted by signal {pending[0]}')


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def write_json(path: Path, value: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, indent=2) + '\n', encoding='utf-8')
    temporary.replace(path)


def command(argv, *, env=None, timeout=30, input=None, check=True):
    result = subprocess.run([str(value) for value in argv], env=env, input=input,
                            capture_output=True, text=True, encoding='utf-8',
                            errors='replace', timeout=timeout)
    if check and result.returncode:
        raise RuntimeError(f"Command failed ({result.returncode}): {argv}\n{result.stdout}\n{result.stderr}")
    return result


def process_info(pid: int):
    result = command(['ps', '-p', str(pid), '-o', 'lstart=,pgid=,stat=,command='], check=False)
    if result.returncode or not result.stdout.strip():
        return None
    fields = result.stdout.strip().split(None, 7)
    if len(fields) != 8:
        raise RuntimeError(f'Cannot identify owned process {pid}')
    if fields[6].startswith('Z'):
        return None
    return {'started': ' '.join(fields[:5]), 'pgid': int(fields[5]), 'command': fields[7]}


def group_members(pgid: int) -> list[int]:
    result = command(['ps', '-axo', 'pid=,pgid=,stat='])
    members = []
    for line in result.stdout.splitlines():
        fields = line.split()
        if len(fields) == 3 and int(fields[1]) == pgid and not fields[2].startswith('Z'):
            members.append(int(fields[0]))
    return members


def matches_process(state: dict, info: dict) -> bool:
    try:
        argv = shlex.split(info['command'])
        pairs = list(zip(argv, argv[1:]))
        executable = Path(argv[0]).name
        return (
            state['pid'] == state['pgid'] == info['pgid']
            and state['processStarted'] == info['started']
            and (executable == 'emulator' or executable.startswith('qemu-system-'))
            and ('-avd', state['avdName']) in pairs
            and ('-port', str(state['port'])) in pairs
        )
    except (KeyError, ValueError, IndexError):
        return False


def validate_coordinates(abi: str, name: str, port: int) -> None:
    if abi not in ABIS:
        raise ValueError(f'Unsupported ABI: {abi}')
    if not re.fullmatch(r'[A-Za-z0-9_-]{1,80}', name):
        raise ValueError('AVD name must contain only letters, digits, underscore or hyphen')
    if port < 5554 or port > 5682 or port % 2:
        raise ValueError('Emulator port must be an even value from 5554 through 5682')


def check_ports(port: int) -> None:
    sockets = []
    try:
        for value in (port, port + 1):
            sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
            sockets.append(sock)
            try:
                # Ignore closed connections in TIME_WAIT; an active listener must
                # still conflict. Never use SO_REUSEPORT to share an owned port.
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
                sock.bind(('127.0.0.1', value))
                sock.listen(1)
            except OSError as error:
                raise RuntimeError(f'Port {value} is occupied; refusing to replace an existing emulator') from error
    finally:
        for sock in sockets:
            sock.close()


def find_avdmanager(sdk: Path) -> Path:
    for version in ['latest', *sorted((sdk / 'cmdline-tools').glob('*'), reverse=True)]:
        directory = sdk / 'cmdline-tools' / version if isinstance(version, str) else version
        executable = directory / 'bin/avdmanager'
        if executable.is_file() and os.access(executable, os.X_OK):
            return executable
    raise FileNotFoundError('Android command-line tools with avdmanager are required')


def validate_state(state: dict) -> None:
    if not isinstance(state, dict) or state.get('schemaVersion') != 1:
        raise ValueError('Unsupported emulator state schema')
    required = {'status', 'ownerToken', 'sdkRoot', 'avdHome', 'avdName', 'port', 'serial', 'abi',
                'sdk', 'pid', 'pgid', 'processStarted', 'processOwned', 'avdOwned', 'startedAt', 'errors'}
    if not required.issubset(state):
        raise ValueError('Emulator state is missing required ownership fields')
    if (type(state['processOwned']) is not bool or type(state['avdOwned']) is not bool
            or state['status'] not in {'starting', 'passed', 'failed'}
            or not isinstance(state['errors'], list)
            or not isinstance(state['startedAt'], str)
            or not isinstance(state['ownerToken'], str)
            or not re.fullmatch(r'[a-f0-9]{32}', state['ownerToken'])):
        raise ValueError('Emulator state has invalid ownership field types')
    if type(state['port']) is not int or not isinstance(state['avdName'], str):
        raise ValueError('Emulator state has invalid AVD coordinates')
    validate_coordinates(state['abi'], state['avdName'], state['port'])
    if state['sdk'] != 33 or state['serial'] != f"emulator-{state['port']}":
        raise ValueError('Emulator state serial/API does not match its coordinates')
    for field in ['sdkRoot', 'avdHome']:
        value = state[field]
        if not isinstance(value, str) or not Path(value).is_absolute() or str(Path(value).resolve()) != value:
            raise ValueError('Emulator state paths must remain canonical absolute paths')
    if any(value is not None and (type(value) is not int or value <= 0)
           for value in [state['pid'], state['pgid']]):
        raise ValueError('Emulator state has invalid process identity')
    if state['pid'] != state['pgid'] or (state['processOwned'] and state['pid'] is None):
        raise ValueError('Emulator state has inconsistent process ownership')
    if state['processStarted'] is not None and not isinstance(state['processStarted'], str):
        raise ValueError('Emulator state has invalid process start identity')


def stop(output: Path, *, acquired_process=None, acquired_state=None) -> dict:
    output = output.resolve()
    path = output / 'state.json'
    result = {'schemaVersion': 1, 'status': 'passed', 'owned': False, 'actions': [], 'errors': []}
    state = None

    def action(name, operation):
        try:
            operation()
            result['actions'].append({'action': name, 'passed': True})
            return True
        except Exception as error:
            message = f'{type(error).__name__}: {error}'
            result['actions'].append({'action': name, 'passed': False, 'error': message})
            result['errors'].append(message)
            return False

    def stop_process():
        if acquired_process is not None and state['processStarted'] is None:
            # Only the current start() can supply this unreaped child handle. Its
            # PID cannot be reused while poll() confirms it is still our child.
            if acquired_process.pid != state['pid']:
                raise RuntimeError('Acquired child identity differs from emulator state')
            if acquired_process.poll() is not None:
                if group_members(state['pgid']):
                    raise RuntimeError('Exited child left an unverified process group')
                return
            if os.getpgid(acquired_process.pid) != state['pgid']:
                raise RuntimeError('Acquired child lost its dedicated process group')
        else:
            info = process_info(state['pid'])
            members = group_members(state['pgid'])
            if info is None:
                if members:
                    raise RuntimeError('Owned group leader is absent but group remains; refusing an unverified signal')
                return
            if not matches_process(state, info):
                raise RuntimeError('PID ownership changed; refusing to signal a foreign process')
        os.killpg(state['pgid'], signal.SIGTERM)
        deadline = time.monotonic() + 10
        while group_members(state['pgid']) and time.monotonic() < deadline:
            time.sleep(0.2)
        if group_members(state['pgid']):
            # The still-existing session was verified before SIGTERM; its group cannot be reused.
            os.killpg(state['pgid'], signal.SIGKILL)
            deadline = time.monotonic() + 5
            while group_members(state['pgid']) and time.monotonic() < deadline:
                time.sleep(0.1)
        if group_members(state['pgid']):
            raise RuntimeError('Owned emulator process group survived cleanup')

    def remove_avd():
        home = Path(state['avdHome'])
        name = state['avdName']
        validate_coordinates(state['abi'], name, state['port'])
        marker = home / ('.agentforge-' + name + '.json')
        if not marker.is_file() or marker.is_symlink():
            raise RuntimeError('AVD ownership marker is missing; refusing cleanup')
        ownership = json.loads(marker.read_text(encoding='utf-8'))
        if ownership != {'ownerToken': state['ownerToken'], 'output': str(output)}:
            raise RuntimeError('AVD ownership marker changed; refusing cleanup')
        directory = home / (name + '.avd')
        ini = home / (name + '.ini')
        if directory.is_symlink() or ini.is_symlink():
            raise RuntimeError('Owned AVD path became a symlink; refusing cleanup')
        if directory.exists():
            shutil.rmtree(directory)
        ini.unlink(missing_ok=True)
        marker.unlink()

    try:
        if acquired_state is not None or path.exists():
            # A failing start retains ownership in memory even if evidence storage failed.
            state = acquired_state if acquired_state is not None else json.loads(path.read_text(encoding='utf-8'))
            validate_state(state)
            result['owned'] = bool(state.get('processOwned') or state.get('avdOwned'))
            process_stopped = True
            if state.get('processOwned'):
                process_stopped = action('stop-owned-process-group', stop_process)
                if process_stopped:
                    state['processOwned'] = False
            if state.get('avdOwned') and process_stopped:
                if action('remove-owned-avd', remove_avd):
                    state['avdOwned'] = False
            if not process_stopped and state.get('avdOwned'):
                result['errors'].append('Owned AVD retained because process cleanup failed')
            state['cleanupStatus'] = 'passed' if not result['errors'] else 'failed'
            state['stoppedAt'] = now()
            write_json(path, state)
    except Exception as error:
        result['errors'].append(f'{type(error).__name__}: {error}')
    result['status'] = 'failed' if result['errors'] else 'passed'
    result['finishedAt'] = now()
    write_json(output / 'cleanup.json', result)
    return result


def start(args) -> dict:
    validate_coordinates(args.abi, args.avd_name, args.port)
    sdk, home, output = args.sdk_root.resolve(), args.avd_home.resolve(), args.output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    state = {
        'schemaVersion': 1, 'status': 'starting', 'ownerToken': uuid.uuid4().hex,
        'sdkRoot': str(sdk), 'avdHome': str(home), 'avdName': args.avd_name,
        'port': args.port, 'serial': f'emulator-{args.port}', 'abi': args.abi, 'sdk': 33,
        'pid': None, 'pgid': None, 'processStarted': None,
        'processOwned': False, 'avdOwned': False, 'startedAt': now(), 'errors': [],
    }
    state_path = output / 'state.json'
    write_json(state_path, state)
    env = {**os.environ, 'ANDROID_HOME': str(sdk), 'ANDROID_AVD_HOME': str(home)}
    adb, emulator = sdk / 'platform-tools/adb', sdk / 'emulator/emulator'
    process = None
    try:
        if os.name != 'posix':
            raise RuntimeError('This lifecycle owner requires POSIX process sessions')
        for executable in [adb, emulator]:
            if not executable.is_file() or not os.access(executable, os.X_OK):
                raise FileNotFoundError(f'Missing executable: {executable}')
        image = sdk / f'system-images/android-33/default/{args.abi}/source.properties'
        properties = image.read_text(encoding='utf-8')
        values = dict(line.split('=', 1) for line in properties.splitlines() if '=' in line)
        if values.get('AndroidVersion.ApiLevel') != '33' or values.get('SystemImage.Abi') != args.abi or values.get('SystemImage.TagId') != 'default':
            raise ValueError('Installed image is not the requested API 33 default ABI')
        state['systemImage'] = {'path': str(image), 'properties': properties}
        avdmanager = find_avdmanager(sdk)
        if platform.system() == 'Darwin':
            check = command([emulator, '-accel-check'], env=env, check=False)
            text = check.stdout + check.stderr
            state['macAccelCheck'] = {'status': 'passed' if check.returncode == 0 else 'failed', 'output': text}
            if check.returncode or not re.search(r'Hypervisor[. ]Framework|HVF', text, re.I):
                state['macAccelCheck']['status'] = 'failed'
                raise RuntimeError('macOS Hypervisor.Framework acceleration is unavailable')
        else:
            state['macAccelCheck'] = {'status': 'not-requested'}
        check_ports(args.port)
        devices = command([adb, 'devices'], env=env).stdout
        if any(line.split() and line.split()[0] == state['serial'] for line in devices.splitlines()):
            raise RuntimeError('Requested emulator serial already exists; refusing to replace it')
        home.mkdir(parents=True, exist_ok=True)
        marker = home / ('.agentforge-' + args.avd_name + '.json')
        if any(path.exists() or path.is_symlink() for path in [home / (args.avd_name + '.avd'), home / (args.avd_name + '.ini'), marker]):
            raise FileExistsError('Requested AVD already exists; refusing to reuse or erase it')
        with defer_interrupts():
            with marker.open('x', encoding='utf-8') as stream:
                json.dump({'ownerToken': state['ownerToken'], 'output': str(output)}, stream)
            state['avdOwned'] = True
            write_json(state_path, state)
        creation = command([avdmanager, 'create', 'avd', '--name', args.avd_name,
                            '--package', f'system-images;android-33;default;{args.abi}',
                            '--device', 'pixel_2', '--path', home / (args.avd_name + '.avd')],
                           env=env, input='no\n', timeout=60)
        (output / 'avd-create.log').write_text(creation.stdout + creation.stderr, encoding='utf-8')
        argv = [str(emulator), '-avd', args.avd_name, '-port', str(args.port),
                '-no-window', '-noaudio', '-no-boot-anim', '-no-snapshot', '-wipe-data',
                '-gpu', 'swiftshader', '-feature', '-Vulkan', '-memory', '2048',
                '-cores', '2', '-accel', 'on']
        state['command'] = argv
        with defer_interrupts():
            with (output / 'emulator.log').open('wb') as log:
                process = subprocess.Popen(argv, env=env, stdin=subprocess.DEVNULL, stdout=log,
                                           stderr=subprocess.STDOUT, start_new_session=True)
            # start_new_session establishes PGID == PID before exec; save the
            # acquired child before the fallible ps identity query.
            state.update(pid=process.pid, pgid=process.pid, processOwned=True)
            info = process_info(process.pid)
            if info is None:
                raise RuntimeError('Emulator exited before process identity was captured')
            state['processStarted'] = info['started']
            write_json(state_path, state)
        if not matches_process(state, info):
            raise RuntimeError('Spawned emulator did not retain its dedicated process session')
        deadline = time.monotonic() + BOOT_TIMEOUT
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError('Emulator exited during boot; see emulator.log')
            boot = command([adb, '-s', state['serial'], 'shell', 'getprop', 'sys.boot_completed'],
                           env=env, timeout=5, check=False)
            if boot.returncode == 0 and boot.stdout.strip() == '1':
                break
            time.sleep(1)
        else:
            raise TimeoutError(f'Emulator boot exceeded {BOOT_TIMEOUT} seconds')
        actual_api = command([adb, '-s', state['serial'], 'shell', 'getprop', 'ro.build.version.sdk'], env=env).stdout.strip()
        actual_abi = command([adb, '-s', state['serial'], 'shell', 'getprop', 'ro.product.cpu.abi'], env=env).stdout.strip()
        actual_avd = command([adb, '-s', state['serial'], 'emu', 'avd', 'name'], env=env).stdout.splitlines()
        if actual_api != '33' or actual_abi != args.abi or not actual_avd or actual_avd[0].strip() != args.avd_name:
            raise RuntimeError('Booted emulator API/ABI/AVD identity differs from owned request')
        root = command([adb, '-s', state['serial'], 'root'], env=env, timeout=20)
        state['adbRoot'] = (root.stdout + root.stderr).strip()
        while time.monotonic() < deadline:
            user = command([adb, '-s', state['serial'], 'shell', 'id', '-u'], env=env, timeout=5, check=False)
            if user.returncode == 0 and user.stdout.strip() == '0':
                break
            time.sleep(1)
        else:
            raise RuntimeError('Emulator did not provide a root shell within startup timeout')
        state.update(status='passed', readyAt=now(), device={'sdk': 33, 'abi': actual_abi, 'uid': 0, 'avdName': args.avd_name})
        write_json(state_path, state)
        return state
    except BaseException as error:
        # Further termination signals must not interrupt ownership-checked cleanup.
        previous = {number: signal.signal(number, signal.SIG_IGN) for number in [signal.SIGINT, signal.SIGTERM]}
        try:
            state['status'] = 'failed'
            state['errors'].append(f'{type(error).__name__}: {error}')
            try:
                write_json(state_path, state)
            finally:
                # Cleanup must run even when recording the startup failure fails.
                stop(output, acquired_process=process, acquired_state=state)
        finally:
            for number, handler in previous.items():
                signal.signal(number, handler)
        raise


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    modes = parser.add_subparsers(dest='mode', required=True)
    launch = modes.add_parser('start')
    launch.add_argument('--sdk-root', type=Path, required=True)
    launch.add_argument('--avd-home', type=Path, required=True)
    launch.add_argument('--avd-name', required=True)
    launch.add_argument('--port', type=int, default=5580)
    launch.add_argument('--abi', choices=ABIS, default='x86_64')
    launch.add_argument('--output', type=Path, required=True)
    shutdown = modes.add_parser('stop')
    shutdown.add_argument('--output', type=Path, required=True)
    args = parser.parse_args(argv)

    def interrupted(number, _frame):
        raise InterruptedError(f'Emulator lifecycle interrupted by signal {number}')

    previous = {number: signal.signal(number, interrupted if args.mode == 'start' else signal.SIG_IGN)
                for number in [signal.SIGINT, signal.SIGTERM]}
    try:
        result = start(args) if args.mode == 'start' else stop(args.output)
        print(json.dumps({'status': result['status'], 'output': str(args.output.resolve())}))
        return 0 if result['status'] == 'passed' else 1
    except (Exception, KeyboardInterrupt) as error:
        print(f'{type(error).__name__}: {error}', file=sys.stderr)
        return 1
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)


if __name__ == '__main__':
    raise SystemExit(main())
