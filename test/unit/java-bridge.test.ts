import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { build } from 'esbuild';

// Exercise the real facade while controlling the external VM callback timing.
const bundle = await build({
  entryPoints: [path.resolve(import.meta.dirname, '../../packages/runtime/java-bridge.ts')],
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['frida-java-bridge'],
  write: false,
});

function facadeFor(
  perform: (callback: () => void) => void,
  extras: Record<string, unknown> = {}
): {
  performOnJava<T>(callback: () => T | Promise<T>): Promise<T>;
  initializeJavaClassLoader(timeoutMs: number): Promise<boolean>;
} {
  const module = { exports: {} };
  runInNewContext(bundle.outputFiles[0].text, {
    module,
    exports: module.exports,
    setTimeout,
    require(name: string) {
      assert.equal(name, 'frida-java-bridge');
      return { available: true, perform, ...extras };
    },
  });
  return module.exports as ReturnType<typeof facadeFor>;
}

test('performOnJava resolves successful Java work', async () => {
  const facade = facadeFor(callback => callback());
  assert.equal(await facade.performOnJava(() => 42), 42);
});

test('a deferred Java callback throw rejects its caller instead of escaping VM dispatch', async () => {
  const queue: Array<() => void> = [];
  const facade = facadeFor(callback => {
    queue.push(callback);
  });
  const failure = new Error('deferred Java failure');
  const pending = facade.performOnJava(() => {
    throw failure;
  });

  assert.equal(queue.length, 1);
  assert.doesNotThrow(() => queue.shift()!());
  await assert.rejects(pending, error => error === failure);
});

test('performOnJava propagates rejected asynchronous Java work', async () => {
  const facade = facadeFor(callback => callback());
  const failure = new Error('asynchronous Java failure');
  await assert.rejects(
    facade.performOnJava(() => Promise.reject(failure)),
    error => error === failure
  );
});

test('performOnJava rejects when the VM cannot schedule work', async () => {
  const failure = new Error('VM unavailable');
  const facade = facadeFor(() => {
    throw failure;
  });
  await assert.rejects(
    facade.performOnJava(() => 42),
    error => error === failure
  );
});

test('app loader initialization uses boot classes before queuing Java work', async () => {
  const loader = {};
  const classFactory = { loader: null as unknown };
  let queries = 0;
  const facade = facadeFor(
    () => {
      throw new Error('must not queue perform before loader');
    },
    {
      classFactory,
      performNow: (callback: () => void) => callback(),
      use: (name: string) => {
        assert.equal(name, 'android.app.ActivityThread');
        return {
          currentApplication: () => (++queries === 1 ? null : { getClassLoader: () => loader }),
        };
      },
    }
  );
  assert.equal(await facade.initializeJavaClassLoader(250), true);
  assert.equal(classFactory.loader, loader);
});

test('app loader initialization has a bounded failure when Application is absent', async () => {
  const facade = facadeFor(callback => callback(), {
    classFactory: { loader: null },
    performNow: (callback: () => void) => callback(),
    use: () => ({ currentApplication: () => null }),
  });
  assert.equal(await facade.initializeJavaClassLoader(10), false);
});
