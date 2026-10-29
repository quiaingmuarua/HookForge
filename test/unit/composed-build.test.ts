import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseComposition, resolvePlan } from '../../hosts/node-cli/composition';
import { compileComposition } from '../../hosts/node-cli/composed-build';
import { runInNewContext } from 'node:vm';

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

test('only selected managed modules are built; naked scripts fail offline; shared bridge is external', async () => {
  const f = fixture();
  try {
    const entry = f.write(
      'managed.ts',
      'export function activate(ctx) { ctx.scope.own("example.api", () => {}); return async () => {}; }'
    );
    const ext = f.write('manifest.json', {
      id: 'example',
      modes: ['trace'],
      owns: ['example.api'],
      entry,
    });
    const unused = f.write('unused.ts', 'throw new Error("must not load");');
    const unusedManifest = f.write('unused.json', {
      id: 'unused',
      modes: ['trace'],
      entry: unused,
    });
    const plan = resolve(['--extension', ext, '--extension', unusedManifest, '--trace', 'example']);
    const built = await compileComposition(plan, workspace, 'const publicBytes = "preserve";');
    assert.ok(built.full.startsWith('const publicBytes = "preserve";\n'));
    assert.ok(!built.inputs.includes(unused));
    assert.ok(!built.inputs.some(input => input.includes('frida-java-bridge')));
    assert.ok(!built.extensions.includes('must not load'));
    assert.match(built.extensions, /example.api/);
    f.write('managed.ts', 'console.log("naked");');
    await assert.rejects(compileComposition(plan, workspace, ''), /must export activate/);
  } finally {
    f.close();
  }
});

test('a new managed API needs no CLI branch; rollback and shutdown await reverse cleanup', async () => {
  const f = fixture();
  try {
    const extension = (id: string, failing: boolean) => {
      const entry = f.write(
        id + '.ts',
        `export async function activate(ctx) {
        ctx.scope.own('${id}.new-api', async () => { await Promise.resolve(); globalThis.fixture.order.push('${id}-scope'); });
        globalThis.fixture.order.push('${id}-active');
        ${failing ? 'throw new Error("activation failed");' : `return async () => { globalThis.fixture.order.push('${id}-cleanup'); };`}
      }`
      );
      return f.write(id + '.json', { id, modes: ['trace'], owns: [id + '.new-api'], entry });
    };
    for (const fail of [false, true]) {
      const a = extension('first', false);
      const b = extension('second', fail);
      const plan = resolve(['--extension', a, '--extension', b, '--trace', 'first,second']);
      const built = await compileComposition(plan, workspace, '');
      const order: string[] = [];
      const rpc: any = { exports: {} };
      const androidApi = {
        beginDispose() {},
        prepare() {},
        configure: async () => {},
        status: () => ({ installed: [] }),
        dispose: async () => {
          order.push('public');
        },
        policy() {},
        subscribe: () => () => {},
      };
      runInNewContext(built.extensions, {
        rpc,
        Process: { id: 42, arch: 'x64' },
        send() {},
        fixture: { order },
        AgentForgeAndroidApi: {
          androidApi,
          Java: {},
          initializeJavaClassLoader: async () => true,
          performOnJava: async (fn: any) => fn(),
        },
      });
      if (fail) {
        await assert.rejects(rpc.exports.start(), /activation failed/);
        assert.deepEqual(order, [
          'first-active',
          'second-active',
          'second-scope',
          'first-cleanup',
          'first-scope',
          'public',
        ]);
      } else {
        await rpc.exports.start();
        await rpc.exports.dispose();
        assert.deepEqual(order, [
          'first-active',
          'second-active',
          'second-cleanup',
          'second-scope',
          'first-cleanup',
          'first-scope',
          'public',
        ]);
      }
    }
  } finally {
    f.close();
  }
});

test('stop waits for pending activation and never activates the next extension afterwards', async () => {
  const f = fixture();
  try {
    const slow = f.write(
      'slow.ts',
      `export async function activate(ctx) {
      ctx.scope.own('slow.api', () => globalThis.fixture.order.push('scope'));
      await new Promise(resolve => { globalThis.fixture.release = resolve; });
      return async () => { globalThis.fixture.order.push('cleanup'); };
    }`
    );
    const next = f.write(
      'next.ts',
      'export function activate() { globalThis.fixture.order.push("unexpected"); return () => {}; }'
    );
    const a = f.write('slow.json', { id: 'slow', modes: ['trace'], entry: slow });
    const b = f.write('next.json', { id: 'next', modes: ['trace'], entry: next });
    const plan = resolve(['--extension', a, '--extension', b, '--trace', 'slow,next']);
    const built = await compileComposition(plan, workspace, '');
    const state: any = { order: [] };
    const rpc: any = { exports: {} };
    const androidApi = {
      beginDispose() {},
      prepare() {},
      configure: async () => {},
      status: () => ({ installed: [] }),
      dispose: async () => {
        state.order.push('public');
      },
      policy() {},
      subscribe: () => () => {},
    };
    runInNewContext(built.extensions, {
      rpc,
      Process: { id: 42, arch: 'x64' },
      send() {},
      fixture: state,
      AgentForgeAndroidApi: {
        androidApi,
        Java: {},
        initializeJavaClassLoader: async () => true,
        performOnJava: async (fn: any) => fn(),
      },
    });
    const starting = rpc.exports.start();
    const rejected = assert.rejects(starting, /stopping/);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(typeof state.release, 'function');
    let finished = false;
    const stopping = rpc.exports.dispose().then(() => {
      finished = true;
    });
    await Promise.resolve();
    assert.equal(finished, false);
    state.release();
    await Promise.all([rejected, stopping]);
    assert.deepEqual(state.order, ['cleanup', 'scope', 'public']);
    assert.equal(rpc.exports.status().state, 'stopped');
  } finally {
    f.close();
  }
});
