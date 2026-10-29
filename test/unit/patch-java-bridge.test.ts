import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const metadataPath = 'patches/frida-java-bridge-7.0.13.patch.json';
const metadata = JSON.parse(fs.readFileSync(path.join(workspace, metadataPath), 'utf8'));
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const installed = fs.readFileSync(
  path.join(workspace, 'node_modules/frida-java-bridge/lib/android.js')
);
// npm ci applies the patch before tests. Recover and re-verify the official source
// for isolated installer tests without storing a vendored copy in this repository.
const official =
  sha256(installed) === metadata.patchedSha256
    ? Buffer.from(
        installed
          .toString('utf8')
          .replace(metadata.replacement.after.join('\n'), metadata.replacement.before.join('\n'))
      )
    : installed;
assert.equal(sha256(official), metadata.originalSha256, 'Test input must match official npm bytes');

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-bridge-patch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'scripts/patch-java-bridge.mjs');
  const target = path.join(root, 'node_modules/frida-java-bridge/lib/android.js');
  const packageJson = path.join(root, 'node_modules/frida-java-bridge/package.json');
  const patch = path.join(root, metadataPath);
  for (const file of [script, target, patch]) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  fs.copyFileSync(path.join(workspace, 'scripts/patch-java-bridge.mjs'), script);
  fs.copyFileSync(path.join(workspace, metadataPath), patch);
  fs.copyFileSync(path.join(workspace, 'package-lock.json'), path.join(root, 'package-lock.json'));
  fs.writeFileSync(
    packageJson,
    JSON.stringify({ name: metadata.packageName, version: metadata.packageVersion })
  );
  fs.writeFileSync(target, official);
  return {
    root,
    target,
    packageJson,
    patch,
    run: (...args: string[]) =>
      spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', windowsHide: true }),
  };
}

test('official source is patched to exact reviewed bytes, then apply and check are read-only', t => {
  const files = fixture(t);
  const before = files.run('--check');
  assert.notEqual(before.status, 0);
  assert.match(before.stderr, /patch is not applied/);
  assert.equal(sha256(fs.readFileSync(files.target)), metadata.originalSha256);
  const applied = files.run();
  assert.equal(applied.status, 0, applied.stderr);
  assert.equal(sha256(fs.readFileSync(files.target)), metadata.patchedSha256);
  const modified = fs.statSync(files.target).mtimeMs;
  assert.equal(files.run().status, 0);
  assert.equal(files.run('--check').status, 0);
  assert.equal(
    fs.statSync(files.target).mtimeMs,
    modified,
    'Idempotent/check calls must not rewrite bytes'
  );
  const evidence = JSON.parse(applied.stdout.slice(applied.stdout.indexOf('{')));
  assert.equal(evidence.metadataSha256, sha256(fs.readFileSync(files.patch)));
  assert.equal(evidence.patchedSha256, metadata.patchedSha256);
});

test('unknown source bytes and line-ending changes fail without modifying the package', t => {
  const files = fixture(t);
  for (const unknown of [
    Buffer.concat([official, Buffer.from('\n// altered\n')]),
    Buffer.from(official.toString('utf8').replace(/\n/g, '\r\n')),
  ]) {
    fs.writeFileSync(files.target, unknown);
    for (const args of [[], ['--check']]) {
      const result = files.run(...args);
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Unknown Frida Java bridge bytes/);
      assert.deepEqual(fs.readFileSync(files.target), unknown);
    }
  }
});

test('package version and npm archive identity must match the reviewed patch', t => {
  const files = fixture(t);
  fs.writeFileSync(
    files.packageJson,
    JSON.stringify({ name: metadata.packageName, version: '7.0.14' })
  );
  assert.match(files.run().stderr, /package version or npm lock differs/);
  fs.writeFileSync(
    files.packageJson,
    JSON.stringify({ name: metadata.packageName, version: metadata.packageVersion })
  );
  const lockPath = path.join(files.root, 'package-lock.json');
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/frida-java-bridge'].integrity = 'sha512-unreviewed';
  fs.writeFileSync(lockPath, JSON.stringify(lock));
  assert.match(files.run().stderr, /package version or npm lock differs/);
  assert.equal(sha256(fs.readFileSync(files.target)), metadata.originalSha256);
});

test('incorrect expected output hash or unmatched replacement cannot write partial patches', t => {
  const files = fixture(t);
  fs.writeFileSync(files.patch, JSON.stringify({ ...metadata, patchedSha256: '0'.repeat(64) }));
  const badHash = files.run();
  assert.notEqual(badHash.status, 0);
  assert.match(badHash.stderr, /patched SHA256 differs/);
  assert.equal(sha256(fs.readFileSync(files.target)), metadata.originalSha256);
  fs.writeFileSync(
    files.patch,
    JSON.stringify({
      ...metadata,
      replacement: { ...metadata.replacement, before: ['missing source location'] },
    })
  );
  const missing = files.run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /exactly one location/);
  assert.equal(sha256(fs.readFileSync(files.target)), metadata.originalSha256);
});
