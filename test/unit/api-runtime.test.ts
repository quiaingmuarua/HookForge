import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

test('RPC, policy owner and observation leases share one installation without resetting replacement', async () => {
  const state: any = { installations: 0, disposals: 0 };
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../packages/modules/android-runtime-bypass/api-runtime.ts', import.meta.url)
      ),
    ],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    plugins: [
      {
        name: 'shared-api-fixture',
        setup(builder) {
          builder.onResolve({ filter: /(?:java-bridge|api-hooks)$/ }, args => ({
            path: args.path,
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /java-bridge$/, namespace: 'fixture' }, () => ({
            contents: 'export const initializeJavaClassLoader = async () => true;',
            loader: 'js',
          }));
          builder.onLoad({ filter: /api-hooks$/, namespace: 'fixture' }, () => ({
            contents: `export async function createAndroidApiHooks(policy, options) {
        const state = globalThis.fixture; state.installations++; state.options = options;
        return { activateJava: async () => {}, stopIntervention() {}, configure: async policy => { state.policy = policy; }, dispose: async () => { state.disposals++; return {restored:true}; }, drain: () => ({}), subscribe: () => () => {}, policy: () => state.policy, status: () => ({installed:['get']}) };
      }`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const module = { exports: {} as any };
  runInNewContext(result.outputFiles[0].text, { module, exports: module.exports, fixture: state });
  const runtime = module.exports.createApiRuntime();
  runtime.prepare({ groups: ['system-properties'] });
  const [replacement, rpc] = await Promise.all([
    runtime.acquire({ mode: 'replace', rules: { properties: { a: 'b' } } }),
    runtime.configure({ mode: 'observe' }),
  ]);
  assert.equal(state.installations, 1);
  // Set the final policy, then add an observer: subscribing must not reset it.
  await runtime.configure({ mode: 'replace', rules: { properties: { a: 'b' } } });
  const observer = await runtime.acquire();
  assert.equal(runtime.policy().mode, 'replace');
  assert.throws(() => runtime.prepare({ groups: [] }), /already fixed/);
  await observer.release();
  assert.equal(state.disposals, 0);
  await replacement.release();
  assert.equal(state.disposals, 1);
  await assert.rejects(runtime.configure({ mode: 'observe' }), /disposed/);
  assert.equal(rpc, undefined);
});

test('early native preparation is shared with Java activation and can be disposed while the loader is unavailable', async () => {
  const state: any = {
    installations: 0,
    javaWaits: 0,
    javaActivations: 0,
    disposals: 0,
    allowJava: false,
  };
  const result = await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../packages/modules/android-runtime-bypass/api-runtime.ts', import.meta.url)
      ),
    ],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    plugins: [
      {
        name: 'early-runtime',
        setup(builder) {
          builder.onResolve({ filter: /(?:java-bridge|api-hooks)$/ }, args => ({
            path: args.path,
            namespace: 'early',
          }));
          builder.onLoad({ filter: /java-bridge$/, namespace: 'early' }, () => ({
            contents: `export async function initializeJavaClassLoader(timeout, cancelled) {
        const state=globalThis.fixture; state.javaWaits++;
        while (!state.allowJava && !cancelled()) await new Promise(resolve=>setTimeout(resolve,1));
        return !cancelled();
      }`,
            loader: 'js',
          }));
          builder.onLoad({ filter: /api-hooks$/, namespace: 'early' }, () => ({
            contents: `export async function createAndroidApiHooks(policy, options) {
        const state=globalThis.fixture; state.installations++; state.nativeOnly=options.nativeOnly;
        return { activateJava: async()=>{state.javaActivations++;}, configure: async p=>{state.policy=p;},
          stopIntervention(){state.policy={mode:'observe'};}, dispose:async()=>{state.disposals++; return {restored:true};},
          status:()=>({installed:['get']}), drain:()=>({records:['early']}), policy:()=>state.policy };
      }`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  for (const cancel of [false, true]) {
    Object.assign(state, {
      installations: 0,
      javaWaits: 0,
      javaActivations: 0,
      disposals: 0,
      allowJava: false,
    });
    const module = { exports: {} as any };
    runInNewContext(result.outputFiles[0].text, {
      module,
      exports: module.exports,
      fixture: state,
      setTimeout,
    });
    const runtime = module.exports.createApiRuntime();
    runtime.prepare({ groups: ['system-properties'] });
    const policy = { mode: 'replace', rules: { properties: { key: 'value' } } };
    await runtime.prepareNative(policy);
    assert.equal(state.javaWaits, 0);
    assert.equal(state.nativeOnly, true);
    assert.equal(runtime.policy().mode, 'replace');
    assert.equal(runtime.drain().records[0], 'early');
    const starting = runtime.configure(policy);
    if (cancel) {
      const failed = assert.rejects(starting, /not ready|disposed/);
      await runtime.dispose();
      await failed;
      assert.equal(state.javaActivations, 0);
    } else {
      state.allowJava = true;
      await starting;
      assert.equal(state.javaActivations, 1);
      assert.equal(runtime.policy().mode, 'replace');
      await runtime.dispose();
    }
    assert.equal(state.installations, 1);
    assert.equal(state.disposals, 1);
  }
});
