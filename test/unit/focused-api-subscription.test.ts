import assert from 'node:assert/strict';
import test from 'node:test';
import { build } from 'esbuild';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';

test('focused root signals subscribe to shared calls and preserve entry/leave events without taking hooks', async () => {
  const state: any = { events: [], released: 0, unsubscribed: 0 };
  const built = await build({
    entryPoints: [
      fileURLToPath(
        new URL('../../packages/recipes/audit/android/focused-runtime.ts', import.meta.url)
      ),
    ],
    bundle: true,
    write: false,
    format: 'cjs',
    platform: 'node',
    plugins: [
      {
        name: 'subscription-fixture',
        setup(builder) {
          builder.onResolve({ filter: /(?:java-bridge|java-utils|api-runtime)$/ }, args => ({
            path: args.path,
            namespace: 'fixture',
          }));
          builder.onLoad({ filter: /java-bridge$/, namespace: 'fixture' }, () => ({
            contents: 'export const performOnJava = async fn => fn();',
            loader: 'js',
          }));
          builder.onLoad({ filter: /java-utils$/, namespace: 'fixture' }, () => ({
            contents:
              'export function getJavaClass() { throw new Error("duplicate Java hook installation"); }',
            loader: 'js',
          }));
          builder.onLoad({ filter: /api-runtime$/, namespace: 'fixture' }, () => ({
            contents: `export const androidApi = { async acquire() {
        const state = globalThis.fixture; return { owner: {subscribe(listener, options) { state.listener = listener; state.options = options; return () => state.unsubscribed++; }}, release: async () => { state.released++; } };
      } };`,
            loader: 'js',
          }));
        },
      },
    ],
  });
  const module = { exports: {} as any };
  runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, fixture: state });
  const runtime = module.exports.runtime;
  await runtime.activate({
    env: { platform: 'android', javaAvailable: true },
    recipe: {
      flags: { 'audit.rootSignals': true },
      log() {},
      emit: (event: any) => state.events.push(event),
    },
  });
  assert.equal(state.options.enter, true);
  for (const phase of ['enter', 'leave']) {
    state.listener({
      api: 'SystemProperties.get(1)',
      phase,
      args: { key: 'ro.secure' },
      result: phase === 'leave' ? 'configured' : undefined,
    });
  }
  const events = state.events.filter((event: any) => event.point === 'system/property/get');
  assert.deepEqual(
    events.map((event: any) => event.phase),
    ['enter', 'leave']
  );
  assert.equal(events[1].attrs.result, 'configured');
  await runtime.deactivate();
  assert.equal(state.unsubscribed, 1);
  assert.equal(state.released, 1);
});
