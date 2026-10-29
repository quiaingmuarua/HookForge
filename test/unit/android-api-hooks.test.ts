import assert from 'node:assert/strict';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const bundled = await build({
  entryPoints: [
    fileURLToPath(
      new URL('../../packages/modules/android-runtime-bypass/api-hooks.ts', import.meta.url)
    ),
  ],
  bundle: true,
  write: false,
  format: 'cjs',
  platform: 'node',
  plugins: [
    {
      name: 'runtime-fixture',
      setup(builder) {
        for (const [filter, contents] of [
          [
            /java-bridge$/,
            'export const Java = globalThis.fixture.Java; export const performOnJava = async fn => fn();',
          ],
          [
            /native-bridge$/,
            'export const resolveExportByName = name => globalThis.fixture.resolve(name);',
          ],
          [/@events\/sink$/, 'export const emitTraceEvent = () => {};'],
        ] as const) {
          builder.onResolve({ filter }, args => ({ path: args.path, namespace: 'fixture' }));
          builder.onLoad({ filter, namespace: 'fixture' }, () => ({ contents, loader: 'js' }));
        }
      },
    },
  ],
});

function fixture(missing?: string) {
  const hooks = new Map<string, any>();
  const methods = new Map<string, any>();
  const tags = { value: 'original-tags' };
  const source = { 'ro.test': 'original', other: 'untouched', empty: '' };
  let reads = 0;
  let launches = 0;
  let allocations = 0;
  let address = 0;
  const method = (name: string, original: (...args: any[]) => any) => {
    const value: any = {
      implementation: null,
      call(receiver: any, ...args: any[]) {
        return original.apply(receiver, args);
      },
    };
    methods.set(name, value);
    return value;
  };
  const child = () => ({
    getInputStream() {
      reads++;
      return { text: '[ro.test]: [original]\n[other]: [untouched]\n' };
    },
    waitFor() {
      return 7;
    },
  });
  const start = method('start', () => {
    launches++;
    return child();
  });
  const builder = () => ({
    command: Object.assign(() => ({ toArray: () => ['getprop'] }), {
      overload: () => ({ call() {} }),
    }),
  });
  const getter = (signature: string[]) =>
    method(
      'get' + signature.length,
      (key: keyof typeof source, fallback = '') => source[key] ?? fallback
    );
  const gets = [getter(['String']), getter(['String', 'String'])];
  const classes: Record<string, any> = {
    'android.os.Build': { TAGS: tags },
    'java.lang.Exception': { $new: () => ({}) },
    'android.util.Log': { getStackTraceString: () => 'fixture\ncaller' },
    'java.io.File': { exists: { overload: () => method('exists', () => true) } },
    'android.app.ApplicationPackageManager': {
      getPackageInfo: { overload: () => method('package', () => ({})) },
    },
    'android.os.SystemProperties': {
      get: { overload: (...args: string[]) => gets[args.length - 1] },
    },
    'java.lang.Runtime': {
      exec: {
        overload: (type: string) => method(type, () => start.implementation.call(builder())),
      },
    },
    'java.lang.ProcessBuilder': { start: { overload: () => start } },
    'java.util.Scanner': {
      $new: (stream: any) => ({
        useDelimiter() {
          return this;
        },
        hasNext: () => true,
        next: () => stream.text,
        close() {},
      }),
    },
  };
  const context: any = {
    fixture: {
      Java: {
        use: (name: string) => classes[name],
        array: (_type: string, values: any) => values,
        registerClass: () => ({
          $new: (process: any, text: string) => ({ process, text, wrapped: true }),
        }),
      },
      resolve: (name: string) => (name === missing ? null : name),
    },
    Process: {
      id: 123,
      getCurrentThreadId: () => 1,
      findModuleByAddress: () => ({ name: 'arbitrary-caller.so' }),
    },
    Interceptor: {
      attach: (symbol: string, callbacks: any) => {
        const handle = {
          callbacks,
          detached: false,
          detach() {
            this.detached = true;
          },
        };
        hooks.set(symbol, handle);
        return handle;
      },
      flush() {},
    },
    NativeFunction: function (address: any) {
      if (address === '__system_property_find') {
        return (name: any) => ({
          isNull: () => !Object.prototype.hasOwnProperty.call(source, name.readCString()),
        });
      }
      return address;
    },
    NativeCallback: function (callback: any) {
      allocations++;
      return callback;
    },
    Memory: {
      alloc: () => {
        const id = ++address;
        return { toString: () => 'opaque-' + id };
      },
      allocUtf8String: (text: string) => ({ readCString: () => text }),
    },
    setTimeout,
    Date,
    send() {},
  };
  const module = { exports: {} as any };
  runInNewContext(bundled.outputFiles[0].text, { ...context, module, exports: module.exports });
  const enter = (callback: any) => {
    const callbackAddress = ++address;
    callback.toString = () => 'callback-' + callbackAddress;
    const handle = hooks.get('__system_property_read_callback');
    const invocation = { returnAddress: { toString: () => '0x123' } };
    const cookie = { token: 'original-cookie' };
    const args: any[] = [{}, callback, cookie];
    handle.callbacks.onEnter.call(invocation, args);
    return {
      invoke(key: string, value: string, serial: number) {
        const name = { readCString: () => key };
        const original = { readCString: () => value };
        args[1](args[2], name, original, serial);
        return { name, cookie };
      },
      leave() {
        handle.callbacks.onLeave.call(invocation);
      },
    };
  };
  return {
    context,
    create: module.exports.createAndroidApiHooks,
    enter,
    hooks,
    methods,
    gets,
    tags,
    log: classes['android.util.Log'],
    builder,
    stats: () => ({ reads, launches }),
    callbackAllocations: () => allocations,
  };
}

function nativeGet(f: ReturnType<typeof fixture>, key: string, value: string, enterOnly = false) {
  const callbacks = f.hooks.get('__system_property_get').callbacks;
  const buffer = {
    text: value,
    bytes: Buffer.alloc(92, 0x5a),
    readUtf8String() {
      return this.text;
    },
    writeUtf8String(text: string) {
      this.text = text;
      this.bytes.write(text, 0, 'utf8');
      this.bytes[Buffer.byteLength(text)] = 0;
    },
  };
  buffer.writeUtf8String(value);
  const result = {
    length: Buffer.byteLength(value),
    toInt32() {
      return this.length;
    },
    replace(length: number) {
      this.length = length;
    },
  };
  const context = { returnAddress: { toString: () => '0x1234' } };
  callbacks.onEnter.call(context, [{ readCString: () => key }, buffer]);
  const leave = () => callbacks.onLeave.call(context, result);
  if (!enterOnly) {
    leave();
  }
  return { buffer, result, leave };
}

test('legacy native getter preserves originals, writes UTF-8 lengths, distinguishes empty/missing and rejects unrepresentable values', async () => {
  const f = fixture();
  const owner = await f.create(
    { mode: 'observe' },
    { groups: ['system-properties'], nativeOnly: true }
  );
  const original = nativeGet(f, 'ro.test', 'original');
  assert.equal(original.buffer.text, 'original');
  assert.equal(original.result.length, 8);
  for (const value of ['é中', '', 'x'.repeat(91)]) {
    await owner.configure({ mode: 'replace', rules: { properties: { 'ro.test': value } } });
    const changed = nativeGet(f, 'ro.test', 'original');
    assert.equal(changed.buffer.text, value);
    assert.equal(changed.result.length, Buffer.byteLength(value));
    assert.equal(changed.buffer.bytes[changed.result.length], 0);
  }
  await owner.configure({
    mode: 'replace',
    rules: { properties: { missing: 'created', empty: 'present' } },
  });
  assert.equal(nativeGet(f, 'missing', '').buffer.text, '');
  assert.equal(nativeGet(f, 'empty', '').buffer.text, 'present');
  assert.equal(nativeGet(f, 'other', 'untouched').buffer.text, 'untouched');
  for (const value of ['é'.repeat(46), 'bad\0value', '\ud800']) {
    await owner.configure({ mode: 'replace', rules: { properties: { 'ro.test': value } } });
    const failed = nativeGet(f, 'ro.test', 'original');
    assert.equal(failed.buffer.text, 'original');
    assert.equal(failed.result.length, 8);
    assert.equal(owner.drain().records.at(-1).runtimeError, true);
  }
  await owner.dispose();
});

test('native preparation never touches Java, activation preserves records/policy, and disposal waits for a fixed-policy getter', async () => {
  const f = fixture();
  let javaCalls = 0;
  const use = f.context.fixture.Java.use;
  f.context.fixture.Java.use = (...args: any[]) => {
    javaCalls++;
    return use(...args);
  };
  const owner = await f.create(
    { mode: 'replace', rules: { properties: { 'ro.test': 'first' } } },
    { groups: ['system-properties'], nativeOnly: true }
  );
  assert.equal(javaCalls, 0);
  const pending = nativeGet(f, 'ro.test', 'original', true);
  await owner.activateJava();
  assert.ok(javaCalls > 0);
  await owner.configure({ mode: 'replace', rules: { properties: { 'ro.test': 'second' } } });
  let disposed = false;
  const closing = owner.dispose().then(() => {
    disposed = true;
  });
  await new Promise(resolve => setTimeout(resolve, 1));
  assert.equal(disposed, false);
  pending.leave();
  assert.equal(pending.buffer.text, 'first');
  await closing;
  assert.equal(owner.drain().records.at(-1).result, 'first');
  assert.equal(
    [...f.hooks.values()].every((hook: any) => hook.detached),
    true
  );
});

test('partially installed native hooks roll back without a Java loader', async () => {
  const f = fixture('stat');
  f.context.fixture.Java.use = () => {
    throw new Error('Java must not be touched');
  };
  await assert.rejects(f.create({ mode: 'observe' }, { nativeOnly: true }), /stat/);
  assert.ok([...f.hooks.values()].every((hook: any) => hook.detached));
});

test('selected groups install once and subscription errors preserve the original result', async () => {
  const f = fixture();
  const api = await f.create(
    { mode: 'observe' },
    { groups: ['system-properties'], traceGroups: [] }
  );
  assert.equal(f.hooks.has('open'), false);
  assert.equal(f.methods.has('exists'), false);
  assert.equal(f.methods.has('java.lang.String'), true);
  const unsubscribe = api.subscribe(() => {
    throw new Error('subscriber failed');
  });
  assert.equal(f.gets[0].implementation.call({}, 'ro.test'), 'original');
  assert.equal(api.drain().records[0].runtimeError, true);
  unsubscribe();
  await api.configure({ mode: 'replace', rules: { properties: { 'ro.test': 'original' } } });
  assert.equal(f.gets[0].implementation.call({}, 'ro.test'), 'original');
  const records = api.drain().records;
  assert.equal(records.length, 1);
  assert.equal(records[0].matched, true);
  assert.equal(records[0].changed, false);
  await assert.rejects(
    api.configure({ mode: 'replace', rules: { fileExists: { '/a': false } } }),
    /not selected/
  );
  assert.equal(api.status().counts.runtimeErrors, 1);
  await api.dispose();
});

test('legacy and new Build policies use one owner and never add field mutations to API-call counts', async () => {
  const f = fixture();
  const api = await f.create(
    { mode: 'replace', rules: { buildTags: 'chosen', buildFields: { TAGS: 'chosen' } } },
    { groups: ['build', 'build-fields'] }
  );
  assert.equal(f.tags.value, 'chosen');
  assert.equal(api.status().counts.calls, 0);
  const receipt = await api.configure({ mode: 'observe' });
  assert.equal(f.tags.value, 'original-tags');
  assert.equal(receipt.buildTags.original, 'original-tags');
  assert.equal(receipt.buildFields.TAGS.restored, true);
  await api.configure({ mode: 'replace', rules: { buildFields: { TAGS: 'again' } } });
  await api.dispose();
  assert.equal(f.tags.value, 'original-tags');
  const legacy = await f.create({ mode: 'observe' }, { groups: ['build'] });
  await assert.rejects(
    legacy.configure({ mode: 'replace', rules: { buildFields: { TAGS: 'bad' } } }),
    /not selected/
  );
  await legacy.dispose();
});

test('entry subscriptions observe the real call boundary and cannot mutate collected results', async () => {
  const f = fixture();
  const api = await f.create(
    { mode: 'replace', rules: { properties: { 'ro.test': 'chosen' } } },
    { groups: ['system-properties'] }
  );
  const phases: string[] = [];
  api.subscribe(
    (event: any) => {
      phases.push(event.phase);
      event.result = 'tampered';
    },
    { enter: true }
  );
  assert.equal(f.gets[0].implementation.call({}, 'ro.test'), 'chosen');
  assert.deepEqual(phases, ['enter', 'leave']);
  assert.equal(api.drain().records[0].result, 'chosen');
  await api.dispose();
});

test('failed field restoration rejects dispose while other API hooks are still removed', async () => {
  const f = fixture();
  let value = f.tags.value;
  let failRestore = false;
  Object.defineProperty(f.tags, 'value', {
    get: () => value,
    set(next) {
      if (failRestore && next === 'original-tags') {
        throw new Error('field restore refused');
      }
      value = next;
    },
  });
  const api = await f.create(
    { mode: 'replace', rules: { buildFields: { TAGS: 'chosen' } } },
    { groups: ['build-fields', 'system-properties'] }
  );
  failRestore = true;
  await assert.rejects(api.dispose(), /field restore refused/);
  assert.ok([...f.methods.values()].every(method => method.implementation === null));
  assert.ok([...f.hooks.values()].every(handle => handle.detached));
  failRestore = false;
  await api.dispose();
  assert.equal(f.tags.value, 'original-tags');
});

test('property origin capture runs after the original getter initializes its Java state', async () => {
  const f = fixture();
  let initialized = false;
  const original = f.gets[0].call;
  f.gets[0].call = (...args: any[]) => {
    initialized = true;
    return original(...args);
  };
  f.log.getStackTraceString = () => {
    assert.equal(initialized, true, 'early stack capture can reenter class initialization');
    return 'fixture\nactual-property-caller';
  };
  const api = await f.create(
    { mode: 'observe', captureStack: true },
    { groups: ['system-properties'] }
  );
  assert.equal(f.gets[0].implementation.call({}, 'ro.test'), 'original');
  assert.equal(api.drain().records[0].caller.stack[0], 'actual-property-caller');
  await api.dispose();
});

test('both getters and both process entrypoints use policy; nested starts wrap only once', async () => {
  const f = fixture();
  const api = await f.create({ mode: 'observe' });
  const runtime = f.methods.get('java.lang.String');
  const original = runtime.implementation.call({}, 'getprop');
  assert.equal(original.wrapped, undefined);
  assert.deepEqual(f.stats(), { reads: 0, launches: 1 });
  await api.configure({ mode: 'replace', rules: { properties: { 'ro.test': 'configured' } } });
  for (const get of f.gets) {
    assert.equal(get.implementation.call({}, 'ro.test', 'fallback'), 'configured');
  }
  const wrapped = runtime.implementation.call({}, 'getprop');
  assert.equal(wrapped.text, '[ro.test]: [configured]\n[other]: [untouched]\n');
  assert.equal(wrapped.process.waitFor(), 7);
  assert.deepEqual(f.stats(), { reads: 1, launches: 2 });
  f.methods.get('start').implementation.call(f.builder());
  assert.deepEqual(f.stats(), { reads: 2, launches: 3 });
  const records = api.drain().records;
  assert.equal(records.filter((item: any) => item.api === 'ProcessBuilder.start').length, 1);
  assert.equal(records.filter((item: any) => item.api.startsWith('Runtime.exec')).length, 2);
  await api.dispose();
  assert.ok([...f.methods.values()].every(value => value.implementation === null));
});

test('native callback preserves cookie, name, serial and exactly one call across interleaved reads', async () => {
  const f = fixture();
  const api = await f.create({ mode: 'replace', rules: { properties: { 'ro.test': 'A' } } });
  const calls: any[] = [];
  const first = f.enter((...args: any[]) => calls.push(args));
  await api.configure({ mode: 'replace', rules: { properties: { 'ro.test': 'B' } } });
  const second = f.enter((...args: any[]) => calls.push(args));
  const info2 = second.invoke('ro.test', 'real', 99);
  second.leave();
  const info1 = first.invoke('ro.test', 'real', 42);
  first.leave();
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], info2.cookie);
  assert.equal(calls[0][1], info2.name);
  assert.equal(calls[0][2].readCString(), 'B');
  assert.equal(calls[0][3], 99);
  assert.equal(calls[1][0], info1.cookie);
  assert.equal(calls[1][1], info1.name);
  assert.equal(calls[1][2].readCString(), 'A');
  assert.equal(calls[1][3], 42);
  const unmatched = f.enter((...args: any[]) => calls.push(args));
  unmatched.invoke('other', 'unchanged', 7);
  unmatched.leave();
  assert.equal(calls[2][2].readCString(), 'unchanged');
  await api.configure({ mode: 'observe' });
  const observed = f.enter((...args: any[]) => calls.push(args));
  observed.invoke('ro.test', 'real', 8);
  observed.leave();
  assert.equal(calls[3][2].readCString(), 'real');
  assert.equal(f.callbackAllocations(), 1);
  await api.dispose();
});

test('dispose waits for an admitted callback and partial install failure restores owned hooks', async () => {
  const f = fixture();
  const api = await f.create({ mode: 'observe' });
  const active = f.enter(() => {});
  let complete = false;
  const disposing = api.dispose().then(() => {
    complete = true;
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(complete, false);
  assert.equal(f.hooks.get('__system_property_read_callback').detached, false);
  active.invoke('ro.test', 'real', 5);
  active.leave();
  await disposing;
  assert.ok([...f.hooks.values()].every(handle => handle.detached));
  await assert.rejects(api.configure({ mode: 'observe' }), /disposed/);
  const failed = fixture('open');
  await assert.rejects(failed.create({ mode: 'observe' }), /Required libc open/);
  assert.ok([...failed.hooks.values()].every(handle => handle.detached));
  assert.ok([...failed.methods.values()].every(value => value.implementation === null));
  assert.equal(failed.tags.value, 'original-tags');
});
