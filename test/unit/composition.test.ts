import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComposition, resolvePlan, InputError } from '../../hosts/node-cli/composition';
import { createScopes } from '../../packages/composition/ownership';

const workspace = fileURLToPath(new URL('../..', import.meta.url));
const fixture = () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'af-composition-'));
  return {
    directory,
    write(name: string, value: unknown) {
      const file = path.join(directory, name);
      fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value));
      return file;
    },
    close: () => fs.rmSync(directory, { recursive: true, force: true }),
  };
};
const resolve = (argv: string[]) =>
  resolvePlan(parseComposition(['plan', ...argv], workspace), workspace);

test('early native startup is explicit, spawn-only and declared offline without executing a Host', () => {
  const f = fixture();
  try {
    const host = f.write('host.mjs', 'throw new Error("must not execute while planning");');
    const app = (launch: unknown) =>
      f.write('app.json', { id: 'early', package: 'example.package', host, launch });
    const valid = resolve([
      '--app',
      app({ mode: 'spawn', activity: 'Main', nativeBeforeResume: true }),
      '--trace',
      'system-properties',
    ]);
    assert.equal(valid.app?.launch.nativeBeforeResume, true);
    assert.deepEqual(valid.startup?.nativeBeforeResume, ['system-properties']);
    for (const launch of [
      { mode: 'activity', activity: 'Main', nativeBeforeResume: true },
      { mode: 'spawn', nativeBeforeResume: 'true' },
      { mode: 'spawn', activity: 1 },
    ]) {
      assert.throws(() => resolve(['--app', app(launch)]), /launch|nativeBeforeResume/);
    }
  } finally {
    f.close();
  }
});

test('Build capability is explicit and legacy and field-map TAGS share conflict provenance', () => {
  const f = fixture();
  try {
    const profile = f.write('fields.json', {
      mode: 'replace',
      rules: { buildFields: { MODEL: 'lab', TAGS: 'test-keys' } },
    });
    assert.throws(() => resolve(['--replace', 'root', '--profile', profile]), /without selected/);
    assert.throws(() => resolve(['--trace', 'build-fields']), /does not support/);
    const plan = resolve(['--replace', 'root,build-fields', '--profile', profile]);
    assert.equal(plan.policy.rules?.buildFields?.TAGS, 'test-keys');
    assert.deepEqual(plan.ruleSources['buildFields:TAGS'], [
      'root',
      profile + ' (explicit override)',
    ]);
    assert.equal(resolve(['--replace', 'root']).policy.rules?.buildTags, 'release-keys');
    const entry = f.write('entry.ts', 'export function activate() { return () => {}; }');
    const preset = f.write('preset.json', {
      mode: 'replace',
      rules: { buildFields: { TAGS: 'different' } },
    });
    const ext = f.write('extension.json', {
      id: 'other-fields',
      modes: ['replace'],
      groups: ['build-fields'],
      entry,
      preset,
    });
    assert.throws(
      () => resolve(['--replace', 'root,other-fields', '--extension', ext]),
      /Conflicting/
    );
    const claims = createScopes({});
    assert.throws(() => claims.forOwner('app').own('Build.MODEL', () => {}), /shared API owner/);
  } finally {
    f.close();
  }
});

test('composition unions modes, shares groups, expands the single root preset and records overrides', () => {
  const f = fixture();
  try {
    const profile = f.write('normal.json', {
      mode: 'replace',
      rules: { properties: { 'ro.secure': 'override' } },
    });
    const plan = resolve([
      '--replace',
      'root,system-properties',
      '--replace',
      'root',
      '--trace',
      'file-io',
      '--trace',
      'system-properties',
      '--profile',
      profile,
    ]);
    assert.equal(new Set(plan.groups).size, plan.groups.length);
    assert.deepEqual(plan.options.replace, ['root', 'system-properties']);
    assert.equal(plan.policy.rules!.properties!['ro.secure'], 'override');
    assert.deepEqual(plan.ruleSources['properties:ro.secure'], [
      'root',
      profile + ' (explicit override)',
    ]);
    assert.equal(plan.policy.rules!.fileExists!['/system/xbin/su'], false);
  } finally {
    f.close();
  }
});
test('conflicting extension rules fail; an explicit profile can override a preset', () => {
  const f = fixture();
  try {
    const entry = f.write('extension.ts', 'export function activate() { return async () => {}; }');
    const preset = f.write('preset.json', {
      mode: 'replace',
      rules: { properties: { 'ro.secure': 'different' } },
    });
    const extension = f.write('extension.json', {
      id: 'custom',
      modes: ['replace'],
      groups: ['system-properties'],
      entry,
      preset,
    });
    assert.throws(
      () => resolve(['--extension', extension, '--replace', 'root,custom']),
      /Conflicting rule/
    );
    const profile = f.write('override.json', {
      mode: 'replace',
      rules: { properties: { 'ro.secure': 'chosen' } },
    });
    assert.equal(
      resolve(['--extension', extension, '--replace', 'root,custom', '--profile', profile]).policy
        .rules!.properties!['ro.secure'],
      'chosen'
    );
  } finally {
    f.close();
  }
});
test('input errors and unselected intervention are rejected before device work', () => {
  for (const args of [
    [],
    ['--spawn', 'a', '--attach', 'b'],
    ['--agent', 'a'],
    ['--serial', 's', '--spawn', 'a', '--timeout-ms', '-1'],
  ]) {
    assert.throws(() => parseComposition(['run', ...args]), InputError);
  }
  assert.throws(() => resolve(['--trace', 'unknown']), /Unknown capability/);
  const f = fixture();
  try {
    assert.throws(
      () => parseComposition(['run', '--serial', 's', '--spawn', 'p', '--output', f.directory]),
      /already exists/
    );
    const profile = f.write('profile.json', {
      mode: 'replace',
      rules: { fileExists: { '/tmp/a': false } },
    });
    assert.throws(
      () => resolve(['--replace', 'system-properties', '--profile', profile]),
      /without selected/
    );
    f.write('profile.json', { mode: 'replace', rules: { readOnlyMounts: ['/system'] } });
    assert.throws(
      () => resolve(['--replace', 'system-properties', '--profile', profile]),
      /without selected/
    );
    f.write('profile.json', { mode: 'observe', rules: {} });
    assert.throws(
      () => resolve(['--replace', 'system-properties', '--profile', profile]),
      /mode conflicts/
    );
    f.write('profile.json', { mode: 'replace', rules: { unknown: {} } });
    assert.throws(
      () => resolve(['--replace', 'system-properties', '--profile', profile]),
      /unknown field/
    );
    assert.throws(
      () => resolve(['--script', path.join(f.directory, 'missing.ts')]),
      /Missing entry/
    );
  } finally {
    f.close();
  }
});

test('offline App planning reads declarations without executing host or agent code', () => {
  const f = fixture();
  try {
    const host = f.write('host.mjs', 'throw new Error("must not execute startup");');
    const agent = f.write('agent.ts', 'throw new Error("must not execute script");');
    const app = f.write('app.json', {
      id: 'local-app',
      package: 'example.package',
      launch: { mode: 'spawn' },
      host: './host.mjs',
      agent: './agent.ts',
    });
    const plan = resolve(['--app', app]);
    assert.equal(plan.app?.host, host);
    assert.deepEqual(plan.scripts, [agent]);
    assert.deepEqual(plan.groups, []);
    assert.equal(plan.policy.mode, 'observe');
  } finally {
    f.close();
  }
});
test('declared and runtime ownership conflicts fail and cleanup continues in reverse order', async () => {
  const scopes = createScopes({ 'example.api': 'a' });
  const order: string[] = [];
  const a = scopes.forOwner('a');
  const b = scopes.forOwner('b');
  assert.throws(() => b.own('example.api', () => {}), /conflict/);
  assert.throws(() => a.own('java.io.File.exists', () => {}), /shared API owner/);
  a.own('example.api', () => {
    order.push('a');
  });
  assert.throws(() => a.own('example.api', () => {}), /already acquired/);
  b.defer(() => {
    order.push('b');
    throw new Error('cleanup failed');
  });
  b.defer(() => {
    order.push('c');
  });
  const result = await scopes.close();
  assert.deepEqual(order, ['c', 'b', 'a']);
  assert.equal(result.complete, false);
  assert.throws(() => a.defer(() => {}), /closing/);
});
