import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { buildComposition } from '../../hosts/node-cli/composed-build';
import { openComposition } from '../../hosts/node-cli/composed-cli';
import { parseComposition, resolvePlan } from '../../hosts/node-cli/composition';

const workspace = fileURLToPath(new URL('../..', import.meta.url));

test('local run reads existing public bytes without a build script and writes in the caller project', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hookforge caller with spaces '));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const tool = path.join(root, 'tool');
  const caller = path.join(root, 'project');
  for (const directory of ['capabilities', 'dist', 'packages/composition']) {
    fs.mkdirSync(path.join(tool, directory), { recursive: true });
  }
  fs.mkdirSync(caller);
  fs.writeFileSync(path.join(tool, 'tsconfig.json'), '{}');
  fs.writeFileSync(
    path.join(tool, 'packages/composition/runtime.ts'),
    'export function registerComposition() {}'
  );
  const agent = path.join(tool, 'dist/android-api.js');
  const source = '// already built public bytes\n';
  fs.writeFileSync(agent, source);
  const before = fs.statSync(agent).mtimeMs;
  const argv = ['run', '--serial', 'not-a-device', '--spawn', 'example.package'];
  const plan = resolvePlan(parseComposition(argv, caller), tool);
  const built = await buildComposition(plan, tool);
  assert.equal(built.source, source);
  assert.equal(fs.statSync(agent).mtimeMs, before);

  const previous = process.env.INIT_CWD;
  process.env.INIT_CWD = caller;
  try {
    const run = await openComposition(argv, tool);
    assert.equal(path.dirname(run.output), path.join(caller, '.runtime/frida/runs'));
    assert.equal(fs.existsSync(path.join(tool, '.runtime')), false);
    // No prepare/inject: constructing and closing a run must not contact a device.
    await run.finish();
    assert.equal(run.result.workingDirectory, caller);
    assert.equal(run.result.cleanup.complete, true);
  } finally {
    if (previous === undefined) {
      delete process.env.INIT_CWD;
    } else {
      process.env.INIT_CWD = previous;
    }
  }
  fs.unlinkSync(agent);
  await assert.rejects(buildComposition(plan, tool), /npm run build:prod/);
});

test('isolated npm link exposes the built CLI outside the checkout, including external inputs and preflight failures', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hookforge link with spaces '));
  try {
    const prefix = path.join(root, 'prefix');
    const caller = path.join(root, 'consumer');
    fs.mkdirSync(caller);
    const env: NodeJS.ProcessEnv = { ...process.env, npm_config_prefix: prefix };
    delete env.INIT_CWD;
    const build = spawnSync(process.execPath, ['scripts/build-hosts.mjs'], {
      cwd: workspace,
      env: { ...env, NODE_ENV: 'production' },
      encoding: 'utf8',
      windowsHide: true,
    });
    assert.equal(build.status, 0, build.stderr);
    assert.ok(process.env.npm_execpath, 'Run tests through npm so its CLI path is available');
    const link = spawnSync(
      process.execPath,
      [
        process.env.npm_execpath!,
        'link',
        '--offline',
        '--ignore-scripts',
        '--no-audit',
        '--no-fund',
      ],
      { cwd: workspace, env, encoding: 'utf8', windowsHide: true, timeout: 30000 }
    );
    assert.equal(link.status, 0, link.stderr);
    const bin = path.join(prefix, process.platform === 'win32' ? 'af-frida' : 'bin/af-frida');
    const cli = (args: string[]) =>
      spawnSync(
        process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : bin,
        process.platform === 'win32' ? [bin, ...args] : args,
        { cwd: caller, env, encoding: 'utf8', windowsHide: true, timeout: 20000 }
      );
    const list = cli(['list']);
    assert.equal(list.status, 0, list.stderr);
    assert.deepEqual(
      JSON.parse(list.stdout)
        .map((item: any) => item.id)
        .sort(),
      ['build-fields', 'file-io', 'root', 'system-properties']
    );
    fs.writeFileSync(
      path.join(caller, 'profile.json'),
      JSON.stringify({ mode: 'replace', rules: { properties: { 'ro.debuggable': '0' } } })
    );
    fs.writeFileSync(
      path.join(caller, 'agent.ts'),
      'export function activate() { return () => {}; }'
    );
    fs.writeFileSync(
      path.join(caller, 'app.json'),
      JSON.stringify({
        id: 'external',
        package: 'example.package',
        launch: { mode: 'spawn' },
        agent: 'agent.ts',
      })
    );
    fs.writeFileSync(
      path.join(caller, 'extension.json'),
      JSON.stringify({ id: 'local', modes: ['trace'], entry: 'agent.ts' })
    );
    const plan = cli([
      'plan',
      '--app',
      'app.json',
      '--replace',
      'system-properties',
      '--profile',
      'profile.json',
      '--extension',
      'extension.json',
      '--trace',
      'local',
    ]);
    assert.equal(plan.status, 0, plan.stderr);
    const value = JSON.parse(plan.stdout);
    assert.equal(value.app.agent, path.join(caller, 'agent.ts'));
    assert.equal(value.policy.rules.properties['ro.debuggable'], '0');
    assert.ok(value.extensions.some((item: any) => item.id === 'local'));
    const run = ['run', '--serial', 'not-a-real-device', '--spawn', 'example.package'];
    assert.equal(cli([...run, '--output', '.']).status, 2);
    assert.equal(cli([...run, '--replace', 'unknown']).status, 2);
    assert.equal(fs.existsSync(path.join(caller, '.runtime')), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
