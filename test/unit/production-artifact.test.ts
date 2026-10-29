import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test, { type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';

const workspace = fileURLToPath(new URL('../../', import.meta.url));
const metadataPath = 'patches/frida-java-bridge-7.0.13.patch.json';

function fixture(t: TestContext) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frida-production-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const frida = path.join(root, 'frida');
  const script = path.join(frida, 'scripts/production-artifact.mjs');
  const manifest = path.join(root, 'manifest.json');
  for (const relative of [
    'scripts/production-artifact.mjs',
    'scripts/patch-java-bridge.mjs',
    metadataPath,
    'package-lock.json',
    'node_modules/frida-java-bridge/package.json',
    'node_modules/frida-java-bridge/lib/android.js',
  ]) {
    const target = path.join(frida, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(workspace, relative), target);
  }
  // Only the disposable fixture is patched, regardless of the real install's state.
  const patched = spawnSync(process.execPath, [path.join(frida, 'scripts/patch-java-bridge.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
  });
  assert.equal(patched.status, 0, patched.stderr);
  for (const file of [
    'bundle.js',
    'android-api.js',
    ...['run', 'run-recipe', 'recipe-runner', 'parse-log'].map(name => 'node-cli/' + name + '.js'),
  ]) {
    const target = path.join(frida, 'dist', file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, '// production fixture');
  }
  const git = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: frida, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
  };
  git('init', '--quiet');
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'fixture'
  );
  const artifact = (mode: string) =>
    spawnSync(process.execPath, [script, mode, manifest], {
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'production' },
    });
  return { root, frida, manifest, artifact, git };
}

test('a gitlink pins its own checkout and production provenance never uses the consumer commit', t => {
  const { root, frida, manifest, artifact, git } = fixture(t);
  const parentGit = (...args: string[]) => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const childCommit = spawnSync('git', ['rev-parse', 'HEAD'], {
    cwd: frida,
    encoding: 'utf8',
    windowsHide: true,
  }).stdout.trim();
  parentGit('init', '--quiet');
  parentGit('update-index', '--add', '--cacheinfo', `160000,${childCommit},frida`);
  parentGit(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--quiet',
    '-m',
    'consumer pins tool'
  );
  const consumerCommit = parentGit('rev-parse', 'HEAD');
  assert.notEqual(consumerCommit, childCommit);
  assert.equal(artifact('write').status, 0);
  assert.equal(JSON.parse(fs.readFileSync(manifest, 'utf8')).commit, childCommit);
  git(
    '-c',
    'user.name=Fixture',
    '-c',
    'user.email=fixture@example.test',
    'commit',
    '--allow-empty',
    '--quiet',
    '-m',
    'tool evolves independently'
  );
  assert.equal(parentGit('rev-parse', 'HEAD:frida'), childCommit);
  assert.notEqual(
    artifact('verify').status,
    0,
    'old production bytes belong to the previous tool commit'
  );
  assert.equal(artifact('write').status, 0);
  assert.equal(artifact('verify').status, 0);
});

test('production manifest verifies the public API bundle and rejects changed or missing bytes', t => {
  const { frida, manifest, artifact } = fixture(t);
  const written = artifact('write');
  assert.equal(written.status, 0, written.stderr);
  assert.equal(artifact('verify').status, 0);
  const evidence = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  assert.equal(evidence.schemaVersion, 2);
  assert.equal(evidence.javaBridgePatch.id, 'frida-java-bridge-7.0.13-art-initial-sync');
  const api = path.join(frida, 'dist/android-api.js');
  fs.appendFileSync(api, '\n// altered');
  const changed = artifact('verify');
  assert.notEqual(changed.status, 0);
  assert.match(changed.stderr, /checksum mismatch: dist\/android-api.js/);
  fs.unlinkSync(api);
  assert.notEqual(artifact('verify').status, 0);
});

test('default manifest output belongs to the tool even when invoked from another directory', t => {
  const { root, frida } = fixture(t);
  const written = spawnSync(
    process.execPath,
    [path.join(frida, 'scripts/production-artifact.mjs'), 'write'],
    {
      cwd: root,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, NODE_ENV: 'production' },
    }
  );
  assert.equal(written.status, 0, written.stderr);
  assert.equal(
    fs.existsSync(path.join(frida, '.runtime/frida-api33/production-manifest.json')),
    true
  );
  assert.equal(fs.existsSync(path.join(root, '.runtime')), false);
});

test('production manifest rejects old or missing patch identity and altered patch metadata', t => {
  const { frida, manifest, artifact } = fixture(t);
  assert.equal(artifact('write').status, 0);
  const valid = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  for (const changed of [
    { ...valid, schemaVersion: 1 },
    { ...valid, javaBridgePatch: undefined },
    { ...valid, javaBridgePatch: { ...valid.javaBridgePatch, patchedSha256: '0'.repeat(64) } },
  ]) {
    fs.writeFileSync(manifest, JSON.stringify(changed));
    const rejected = artifact('verify');
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /metadata differs/);
  }
  fs.writeFileSync(manifest, JSON.stringify(valid));
  fs.appendFileSync(path.join(frida, metadataPath), '\n');
  assert.match(artifact('verify').stderr, /metadata differs/);
});

test('manifest write and verify reject unpatched or altered installed source at the same version', t => {
  const { frida, artifact } = fixture(t);
  assert.equal(artifact('write').status, 0);
  const source = path.join(frida, 'node_modules/frida-java-bridge/lib/android.js');
  const patched = fs.readFileSync(source, 'utf8');
  const metadata = JSON.parse(fs.readFileSync(path.join(frida, metadataPath), 'utf8'));
  const official = patched.replace(
    metadata.replacement.after.join('\n'),
    metadata.replacement.before.join('\n')
  );
  for (const [bytes, error] of [
    [official, /patch is not applied/],
    [patched + '\n// altered', /Unknown Frida Java bridge bytes/],
  ] as const) {
    fs.writeFileSync(source, bytes);
    for (const mode of ['write', 'verify']) {
      const rejected = artifact(mode);
      assert.notEqual(rejected.status, 0);
      assert.match(rejected.stderr, error);
    }
  }
});
