import copy
from contextlib import redirect_stderr, redirect_stdout
import hashlib
from io import BytesIO, StringIO
import json
import lzma
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import zipfile

import prepare
from prepare import TARGETS, check_apk, check_client, check_device, check_java_bridge, check_process_arch, check_server, load_spec


def elf_header(abi):
    header = bytearray(64)
    header[:6] = b'\x7fELF\x02\x01'
    header[18:20] = TARGETS[abi][2].to_bytes(2, 'little')
    return bytes(header)


def apk_bytes(abi, header=None):
    output = BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        archive.writestr(f'lib/{abi}/libdetect_sample.so', header if header is not None else elf_header(abi))
    return output.getvalue()


class ToolchainTests(unittest.TestCase):
    def test_expected_patch_provenance_loads_without_node_modules(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            for relative in ['package-lock.json', '.node-version', prepare.JAVA_BRIDGE_PATCH]:
                target = root / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes((prepare.ROOT / relative).read_bytes())
            expected = load_spec()
            self.assertEqual(expected, load_spec(root))
            self.assertFalse((root / 'node_modules').exists())
            metadata_path = root / prepare.JAVA_BRIDGE_PATCH
            metadata = json.loads(metadata_path.read_text(encoding='utf-8'))
            for field, value in [('schemaVersion', 0), ('packageVersion', '7.0.14'),
                                 ('sourceIntegrity', 'sha512-other'), ('originalSha256', 'invalid'),
                                 ('patchedSha256', None)]:
                with self.subTest(field=field):
                    metadata_path.write_text(json.dumps({**metadata, field: value}), encoding='utf-8')
                    with self.assertRaises(ValueError):
                        load_spec(root)
            metadata_path.write_text(json.dumps(metadata), encoding='utf-8')
            self.assertNotEqual(expected['javaBridgePatch']['metadataSha256'],
                                load_spec(root)['javaBridgePatch']['metadataSha256'])

    def test_installed_bridge_requires_patched_source_not_just_matching_version(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            package = root / 'node_modules/frida-java-bridge'
            (package / 'lib').mkdir(parents=True)
            spec = load_spec()
            patched = b'reviewed patched fixture'
            spec['javaBridgePatch']['patchedSha256'] = hashlib.sha256(patched).hexdigest()
            metadata = package / 'package.json'
            metadata.write_text(json.dumps({'name': 'frida-java-bridge', 'version': spec['javaBridgeVersion']}))
            source = package / 'lib/android.js'
            source.write_bytes(patched)
            self.assertEqual(spec['javaBridgePatch'], check_java_bridge(root, spec))
            for content in [b'official unpatched fixture', patched + b'\n']:
                source.write_bytes(content)
                with self.assertRaisesRegex(ValueError, 'patched source checksum mismatch'):
                    check_java_bridge(root, spec)
            source.write_bytes(patched)
            metadata.write_text(json.dumps({'name': 'frida-java-bridge', 'version': '7.0.14'}))
            with self.assertRaisesRegex(ValueError, 'reviewed package/lock'):
                check_java_bridge(root, spec)

    def test_both_android_abis_select_exact_release_and_process_architectures(self):
        self.assertEqual('x86_64', load_spec()['abi'])
        for abi, (server_arch, process_arch, _) in TARGETS.items():
            with self.subTest(abi=abi):
                spec = load_spec(abi=abi)
                self.assertEqual(2, spec['schemaVersion'])
                self.assertEqual(abi, spec['abi'])
                self.assertEqual(server_arch, spec['serverArch'])
                self.assertEqual(process_arch, spec['processArch'])
                check_client(spec['fridaVersion'], spec)
                check_process_arch(process_arch, spec)
                with self.assertRaisesRegex(ValueError, 'Process.arch mismatch'):
                    check_process_arch('arm64-v8a', spec)
                with self.assertRaisesRegex(ValueError, 'Client/lock mismatch'):
                    check_client('17.4.0', spec)
        self.assertNotEqual(load_spec()['serverSha256'], load_spec(abi='arm64-v8a')['serverSha256'])
        with self.assertRaisesRegex(ValueError, 'Unsupported Android ABI'):
            load_spec(abi='arm64')

    def test_lock_update_without_server_checksum_update_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            (root / 'package-lock.json').write_text(json.dumps({'packages': {'node_modules/frida': {'version': '99.0.0'}}}))
            with self.assertRaisesRegex(ValueError, 'checksum lock needs updating'):
                load_spec(root)

    def test_legacy_incomplete_or_mislabeled_locks_have_no_fallback(self):
        valid = json.loads((prepare.HERE / 'toolchain.lock.json').read_text(encoding='utf-8'))
        invalid = [None, [], {**valid, 'schemaVersion': 1}]
        for field, value in [('serverArch', 'arm64-v8a'), ('processArch', 'x64'),
                             ('serverSha256', 'wrong'), ('serverArchiveSha256', None)]:
            item = copy.deepcopy(valid)
            item['targets']['arm64-v8a'][field] = value
            invalid.append(item)
        missing = copy.deepcopy(valid)
        del missing['targets']['arm64-v8a']
        invalid.append(missing)
        for document in invalid:
            with self.subTest(document=document), tempfile.TemporaryDirectory() as temporary:
                lock = Path(temporary) / 'lock.json'
                lock.write_text(json.dumps(document), encoding='utf-8')
                # Validate the complete lock, even when selecting the original x86 target.
                with self.assertRaises(ValueError):
                    load_spec(lock=lock)

    def test_wrong_api_or_device_abi_is_rejected(self):
        check_device('33', 'x86_64')
        for expected in TARGETS:
            check_device('33', expected, expected)
            for api, actual in [('34', expected), ('33', 'arm64'),
                                ('33', 'arm64-v8a' if expected == 'x86_64' else 'x86_64')]:
                with self.subTest(expected=expected, actual=actual), self.assertRaisesRegex(ValueError, 'Expected API 33'):
                    check_device(api, actual, expected)

    def test_apk_requires_selected_native_library_and_matching_elf_arch(self):
        with tempfile.TemporaryDirectory() as temporary:
            apk = Path(temporary) / 'fixture.apk'
            for abi in TARGETS:
                other = 'arm64-v8a' if abi == 'x86_64' else 'x86_64'
                apk.write_bytes(apk_bytes(abi))
                evidence = check_apk(apk, abi)
                self.assertEqual(abi, evidence['abi'])
                self.assertEqual([abi], evidence['nativeAbis'])
                with self.assertRaisesRegex(ValueError, 'must contain exactly one'):
                    check_apk(apk, other)
                apk.write_bytes(apk_bytes(abi, elf_header(other)))
                with self.assertRaisesRegex(ValueError, 'ELF architecture'):
                    check_apk(apk, abi)
                apk.write_bytes(apk_bytes(abi, b'not ELF'))
                with self.assertRaisesRegex(ValueError, 'ELF64'):
                    check_apk(apk, abi)

    def test_missing_or_modified_server_is_rejected(self):
        with tempfile.TemporaryDirectory() as temporary:
            server = Path(temporary) / 'server'
            for abi in TARGETS:
                with self.assertRaisesRegex(FileNotFoundError, 'server is missing'):
                    check_server(server, load_spec(abi=abi))
            server.write_bytes(b'wrong binary')
            for abi in TARGETS:
                with self.assertRaisesRegex(ValueError, 'Server checksum mismatch'):
                    check_server(server, load_spec(abi=abi))

    def test_prepare_downloads_arm64_asset_and_validates_both_hashes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            spec = load_spec(abi='arm64-v8a')
            binary = elf_header('arm64-v8a')
            archive = lzma.compress(binary)
            spec['serverSha256'] = hashlib.sha256(binary).hexdigest()
            spec['serverArchiveSha256'] = hashlib.sha256(archive).hexdigest()
            python = root / 'python'
            python.touch()
            for package, version in [('frida', spec['fridaVersion']), ('frida-java-bridge', spec['javaBridgeVersion'])]:
                metadata = root / 'node_modules' / package / 'package.json'
                metadata.parent.mkdir(parents=True)
                metadata.write_text(json.dumps({'name': package, 'version': version}), encoding='utf-8')
            bridge = root / 'node_modules/frida-java-bridge/lib/android.js'
            bridge.parent.mkdir()
            bridge.write_bytes(b'patched fixture')
            spec['javaBridgePatch']['patchedSha256'] = hashlib.sha256(bridge.read_bytes()).hexdigest()
            output = root / 'toolchain.json'
            commands = []

            def command(argv, **kwargs):
                commands.append(argv)
                text = ('v' + spec['nodeVersion'] if argv[-1] == '--version' and argv[0].endswith('node')
                        else 'Python 3.11' if argv[-1] == '--version' else spec['fridaVersion'])
                return SimpleNamespace(returncode=0, stdout=text, stderr='')

            argv = ['prepare.py', '--abi', 'arm64-v8a', '--python', str(python), '--node', str(root / 'node'),
                    '--tools-root', str(root / 'cache'), '--output', str(output)]
            with patch('sys.argv', argv), patch.object(prepare, 'ROOT', root), \
                 patch.object(prepare, 'load_spec', return_value=spec), \
                 patch.object(prepare.subprocess, 'run', side_effect=command), \
                 patch.object(prepare.urllib.request, 'urlopen', return_value=BytesIO(archive)) as download, \
                 redirect_stdout(StringIO()), redirect_stderr(StringIO()):
                self.assertEqual(0, prepare.main())
                self.assertTrue(download.call_args.args[0].endswith('-android-arm64.xz'))
                result = json.loads(output.read_text(encoding='utf-8'))
                self.assertEqual(2, result['schemaVersion'])
                self.assertEqual('arm64-v8a', result['requestedAbi'])
                self.assertEqual(binary, Path(result['server']).read_bytes())
                self.assertEqual(spec, result['lock'])
                self.assertEqual(spec['javaBridgePatch'], result['javaBridgePatch'])
                Path(result['server']).write_bytes(b'corrupt cache')
                download.reset_mock()
                self.assertEqual(1, prepare.main())
                download.assert_not_called()
            self.assertIn('Server checksum mismatch', json.loads(output.read_text(encoding='utf-8'))['error'])


if __name__ == '__main__':
    unittest.main()
