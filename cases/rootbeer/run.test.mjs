import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  apkNativeAbis,
  checkTargetIdentity,
  options,
  outputDirectory,
  targetForAbi,
} from './run.mjs';

test('runner accepts local usage and requires both production inputs', () => {
  const base = ['--apk', 'sample.apk', '--serial', 'emulator-5554'];
  assert.equal(options([...base, '--reuse-detect-env']).reuse, true);
  assert.equal(options(base).agent, undefined);
  assert.equal(options(base).abi, 'x86_64');
  assert.equal(options([...base, '--abi', 'arm64-v8a']).abi, 'arm64-v8a');
  assert.throws(() => options([...base, '--abi', 'arm64']), /Unsupported/);
  assert.throws(() => options([...base, '--abi', 'arm64-v8a', '--abi', 'x86_64']), /duplicate/);
  for (const extra of [
    ['--agent', 'agent.js'],
    ['--production-manifest', 'manifest.json'],
  ]) {
    assert.throws(() => options([...base, ...extra]), /must be supplied together/);
  }
  const parsed = options([
    ...base,
    '--agent',
    'agent.js',
    '--production-manifest',
    'manifest.json',
    '--output',
    'results',
  ]);
  assert.equal(parsed.agent, path.resolve('agent.js'));
  assert.equal(parsed.output, path.resolve('results'));
  assert.throws(() => options([...base, '--serial', 'another']), /duplicate/);
});

test('ABI selection rejects mismatched lock identities and process architectures', () => {
  const arm = targetForAbi('arm64-v8a');
  assert.equal(arm.serverArch, 'arm64');
  assert.equal(arm.processArch, 'arm64');
  assert.throws(() => targetForAbi('arm64-v8a', { schemaVersion: 1 }), /invalid locked ABI/);
  assert.throws(
    () =>
      targetForAbi('arm64-v8a', {
        schemaVersion: 2,
        targets: { 'arm64-v8a': { ...arm, processArch: 'x64' } },
      }),
    /invalid locked ABI/
  );
  const identity = { package: 'target.app', sdk: 33, arch: 'arm64' };
  checkTargetIdentity(identity, 'target.app', arm);
  for (const changed of [{ sdk: 34 }, { arch: 'x64' }, { package: 'other.app' }]) {
    assert.throws(
      () => checkTargetIdentity({ ...identity, ...changed }, 'target.app', arm),
      /Unexpected target identity/
    );
  }
});

function apkDirectory(names) {
  const entries = names.map(name => {
    const value = Buffer.from(name);
    const entry = Buffer.alloc(46 + value.length);
    entry.writeUInt32LE(0x02014b50);
    entry.writeUInt16LE(value.length, 28);
    value.copy(entry, 46);
    return entry;
  });
  const directory = Buffer.concat(entries);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  return Buffer.concat([directory, end]);
}

test('APK native ABI inspection requires the selected library and rejects damaged directories', () => {
  const bytes = apkDirectory([
    'lib/arm64-v8a/libtool-checker.so',
    'lib/x86_64/libtool-checker.so',
    'lib/armeabi-v7a/other.so',
    'assets/lib/arm64-v8a/libtool-checker.so',
  ]);
  assert.deepEqual(apkNativeAbis(bytes, 'libtool-checker.so'), ['arm64-v8a', 'x86_64']);
  assert.deepEqual(apkNativeAbis(bytes, 'missing.so'), []);
  assert.throws(() => apkNativeAbis(Buffer.alloc(0), 'libtool-checker.so'), /Invalid APK/);
  const damaged = Buffer.from(bytes);
  damaged.writeUInt32LE(0x7fffffff, damaged.length - 22 + 12);
  assert.throws(() => apkNativeAbis(damaged, 'libtool-checker.so'), /Invalid or unsupported/);
});

test('explicit output refuses to replace existing evidence', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rootbeer-output-'));
  try {
    const output = path.join(root, 'run');
    assert.equal(outputDirectory(output), output);
    fs.writeFileSync(path.join(output, 'evidence'), 'preserve');
    assert.throws(() => outputDirectory(output), { code: 'EEXIST' });
    assert.equal(fs.readFileSync(path.join(output, 'evidence'), 'utf8'), 'preserve');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invalid production metadata is rejected before APK or device access', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rootbeer-preflight-'));
  try {
    const manifest = path.join(root, 'manifest.json');
    const output = path.join(root, 'result');
    fs.writeFileSync(manifest, '{}');
    const child = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL('./run.mjs', import.meta.url)),
        '--apk',
        path.join(root, 'does-not-exist.apk'),
        '--serial',
        'not-a-device',
        '--agent',
        path.join(root, 'does-not-exist.js'),
        '--production-manifest',
        manifest,
        '--output',
        output,
      ],
      { encoding: 'utf8', timeout: 30000, windowsHide: true }
    );
    assert.equal(child.status, 1, child.stderr);
    const result = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
    assert.equal(result.agentSource, 'production-artifact');
    assert.match(result.errors.join('\n'), /Production artifact verification failed/);
    assert.equal(result.environment.sdk, undefined);
    assert.deepEqual(result.cleanup.actions, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
