import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type frida from 'frida';
import { runCli } from '../../hosts/node-cli/run';

function signal<T extends (...args: any[]) => void>() {
  const callbacks = new Set<T>();
  return {
    connect: (callback: T) => {
      callbacks.add(callback);
    },
    disconnect: (callback: T) => {
      callbacks.delete(callback);
    },
    emit: (...args: Parameters<T>) => {
      callbacks.forEach(callback => callback(...args));
    },
  };
}

const activated = {
  type: 'send',
  payload: {
    type: 'module-status',
    moduleId: 'android/runtime-bypass',
    status: 'activated',
  },
};
const ready = {
  type: 'send',
  payload: {
    type: 'loader-ready',
    stats: { activatedModules: 1, totalModules: 1, failedModules: 0 },
  },
};

async function exercise(
  messages: unknown[],
  options: {
    verbose?: boolean;
    unloadError?: boolean;
    detachError?: boolean;
    detached?: boolean;
    loadError?: boolean;
    shutdownError?: boolean;
    requireModule?: string;
  } = {}
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'frida-cli-'));
  const config = path.join(root, 'config.json');
  const bundle = path.join(root, 'bundle.js');
  const result = path.join(root, 'result.json');
  const events = path.join(root, 'events.jsonl');
  fs.writeFileSync(config, '{}');
  fs.writeFileSync(bundle, '// controlled agent');
  const message = signal<(value: any) => void>();
  const detached = signal<(reason: string) => void>();
  const actions: string[] = [];
  const script = {
    message,
    exports: {
      shutdown: async () => {
        actions.push('shutdown');
        if (options.shutdownError) {
          throw new Error('restore failed');
        }
      },
    },
    load: async () => {
      if (options.loadError) {
        throw new Error('load failed');
      }
    },
    post: () => {
      if (options.detached) {
        detached.emit('process-terminated');
      }
      messages.forEach(value => message.emit(value));
    },
    unload: async () => {
      await new Promise(resolve => setTimeout(resolve, 2));
      actions.push('unload');
      if (options.unloadError) {
        throw new Error('unload failed');
      }
    },
  };
  const session = {
    detached,
    createScript: async () => script,
    detach: async () => {
      actions.push('detach');
      detached.emit('application-requested');
      if (options.detachError) {
        throw new Error('detach failed');
      }
    },
  };
  const device = {
    enumerateProcesses: async () => [{ name: 'com.detect.app.sample', pid: 42 }],
    attach: async () => session,
  } as unknown as frida.Device;
  try {
    const code = await runCli(
      [
        '--smoke',
        '--timeout-ms',
        '100',
        '--config',
        config,
        '--bundle',
        bundle,
        '--result',
        result,
        '--dump-events',
        events,
        '--require-module',
        options.requireModule ?? 'android/runtime-bypass',
        ...(options.verbose ? ['--verbose'] : []),
        'com.detect.app.sample',
      ],
      async () => device
    );
    return {
      code,
      actions,
      result: JSON.parse(fs.readFileSync(result, 'utf8')),
      events: fs.readFileSync(events, 'utf8'),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('CLI waits for required activation and completes cleanup before returning success', async () => {
  const run = await exercise([activated, ready]);
  assert.equal(run.code, 0);
  assert.equal(run.result.ready, true);
  assert.deepEqual(run.actions, ['unload', 'detach']);
  assert.ok(run.result.cleanup.every((item: any) => item.status === 'passed'));
});

test('verbose CLI still processes readiness and collects trace events', async () => {
  const event = { point: 'test/probe', kind: 'probe' };
  const run = await exercise(
    [{ type: 'send', payload: { type: 'trace-event', event } }, activated, ready],
    { verbose: true }
  );
  assert.equal(run.code, 0);
  assert.deepEqual(JSON.parse(run.events), event);
});

test('smoke timeout without readiness is a failure', async () => {
  const run = await exercise([activated]);
  assert.equal(run.code, 1);
  assert.match(run.result.reason, /timeout/);
  assert.equal(run.result.ready, false);
});

test('structured hook errors cannot be hidden by an activated module and loader-ready', async () => {
  for (const verbose of [false, true]) {
    const run = await exercise(
      [
        {
          type: 'send',
          payload: {
            type: 'trace-event',
            event: {
              point: 'native-install',
              kind: 'error',
              error: { message: 'export missing' },
            },
          },
        },
        activated,
        ready,
      ],
      { verbose }
    );
    assert.equal(run.code, 1);
    assert.equal(run.result.reason, 'structured runtime error');
  }
});

test('loader readiness cannot substitute for a required module activation', async () => {
  const run = await exercise([ready]);
  assert.equal(run.code, 1);
  assert.match(run.result.reason, /activation requirements failed/);
});

test('failed module activation fails smoke even if readiness follows', async () => {
  const run = await exercise([
    {
      type: 'send',
      payload: {
        type: 'module-status',
        moduleId: 'android/runtime-bypass',
        status: 'failed',
        error: 'hook failed',
      },
    },
    ready,
  ]);
  assert.equal(run.code, 1);
  assert.match(run.result.reason, /module activation failed/);
});

test('loader errors fail verbose smoke', async () => {
  const run = await exercise(
    [{ type: 'send', payload: { type: 'loader-error', error: 'VM unavailable' } }],
    { verbose: true }
  );
  assert.equal(run.code, 1);
  assert.equal(run.result.reason, 'loader error');
});

test('script error messages fail smoke in both logging modes', async () => {
  for (const verbose of [false, true]) {
    const run = await exercise(
      [{ type: 'error', description: 'agent failed', stack: 'agent failed stack' }],
      { verbose }
    );
    assert.equal(run.code, 1);
    assert.equal(run.result.reason, 'script error');
  }
});

test('unexpected detach fails smoke', async () => {
  const run = await exercise([], { detached: true });
  assert.equal(run.code, 1);
  assert.match(run.result.reason, /unexpected detach/);
});

test('script load failures still unload and detach', async () => {
  const run = await exercise([], { loadError: true });
  assert.equal(run.code, 1);
  assert.deepEqual(run.actions, ['unload', 'detach']);
});

test('unload or detach failures override an otherwise successful smoke', async () => {
  for (const options of [{ unloadError: true }, { detachError: true }]) {
    const run = await exercise([activated, ready], options);
    assert.equal(run.code, 1);
    assert.equal(run.result.status, 'failed');
    assert.deepEqual(run.actions, ['unload', 'detach']);
    assert.equal(run.result.cleanup.filter((item: any) => item.status === 'failed').length, 1);
  }
});

test('advertised agent shutdown restores fields before unload, and restoration failure still detaches', async () => {
  for (const shutdownError of [false, true]) {
    const run = await exercise(
      [{ type: 'send', payload: { type: 'loader-started', shutdown: true } }, activated, ready],
      { shutdownError }
    );
    assert.equal(run.code, shutdownError ? 1 : 0);
    assert.deepEqual(run.actions, ['shutdown', 'unload', 'detach']);
    assert.equal(run.result.cleanup[0].action, 'agent.shutdown');
    assert.equal(run.result.cleanup[0].status, shutdownError ? 'failed' : 'passed');
  }
});

test('a startup timeout still invokes announced shutdown before unloading', async () => {
  const run = await exercise([
    { type: 'send', payload: { type: 'loader-started', shutdown: true } },
  ]);
  assert.equal(run.code, 1);
  assert.deepEqual(run.actions, ['shutdown', 'unload', 'detach']);
});
