import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSession } from '../../hosts/node-cli/composed-session';
import { parseComposition, resolvePlan } from '../../hosts/node-cli/composition';

const workspace = fileURLToPath(new URL('../..', import.meta.url));
function fixture(argv: string[], failure = '') {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'af-session-'));
  const plan = resolvePlan(
    parseComposition(['run', '--serial', 'test-device', ...argv], workspace),
    workspace
  );
  const calls: string[] = [];
  const events = { connect() {}, disconnect() {} };
  const script = {
    message: events,
    load: async () => {
      calls.push('load');
    },
    unload: async () => {
      calls.push('unload');
    },
    exports: {
      preparenative: async () => {
        calls.push('native-ready');
        if (failure === 'native') {
          throw new Error('native failed');
        }
        return {
          pid: failure === 'native-pid' ? 99 : 42,
          readyAt: Date.now(),
          installed: ['libc.__system_property_get'],
        };
      },
      start: async () => {
        calls.push('java-ready');
        return { installed: [], groups: [], unavailable: [] };
      },
      dispose: async () => {
        calls.push('dispose');
        if (failure === 'dispose') {
          throw new Error('in flight');
        }
        return { restored: true };
      },
      status: async () => ({ counts: { runtimeErrors: 0 } }),
      drain: async () => ({ records: [], dropped: 0 }),
    },
  };
  const device = {
    spawn: async () => {
      calls.push('spawn');
      if (failure === 'spawn') {
        throw new Error('spawn failed');
      }
      return 42;
    },
    resume: async () => {
      calls.push('resume');
    },
    kill: async () => {
      calls.push('kill');
    },
    attach: async () => ({
      detached: events,
      detach: async () => {
        calls.push('detach');
      },
      createScript: async () => {
        calls.push('create');
        if (failure === 'create') {
          throw new Error('create failed');
        }
        return script;
      },
    }),
  };
  const manager = {
    addRemoteDevice: async () => device,
    removeRemoteDevice: async () => {
      calls.push('remove remote');
    },
  };
  let port = 40000;
  const instance = createSession(plan, output, '', {
    manager: manager as any,
    adb(argv, binary) {
      calls.push(argv.join(' '));
      if (failure === 'original-launch' && argv.includes('start')) {
        return 'Error: original launch failed';
      }
      if (argv[0] === 'forward' && argv[1] === 'tcp:0') {
        return String(++port);
      }
      if (binary) {
        return Buffer.from((failure === 'identity' ? 'wrong.package' : 'example.package') + '\0');
      }
      if (argv.includes('pidof')) {
        return '42';
      }
      return '';
    },
  });
  return {
    instance,
    calls,
    output,
    close: () => fs.rmSync(output, { recursive: true, force: true }),
  };
}
test('spawn and attach use one owned session; resume precedes capability readiness; only own forwards are removed', async () => {
  for (const target of [
    ['--spawn', 'example.package'],
    ['--attach', '42'],
  ]) {
    const f = fixture(target);
    try {
      await f.instance.prepare();
      await f.instance.inject();
      await f.instance.drain();
      await f.instance.close();
      const recorded = fs
        .readFileSync(path.join(f.output, 'events.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      assert.equal(recorded.find(item => item.type === 'ready')?.target.pid, 42);
      assert.deepEqual(recorded.find(item => item.type === 'api-observations')?.records, []);
      assert.equal(f.calls.filter(call => call === 'create').length, 1);
      assert.ok(f.calls.indexOf('dispose') < f.calls.indexOf('unload'));
      assert.ok(f.calls.includes('forward --remove tcp:40001'));
      assert.ok(!f.calls.includes('kill'));
      if (target[0] === '--spawn') {
        assert.ok(f.calls.indexOf('load') < f.calls.indexOf('resume'));
      }
      assert.equal(f.instance.result.cleanup.complete, true);
    } finally {
      f.close();
    }
  }
});

test('failed cold spawn or original launch stops only the owned target even without a returned PID', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'af-launch-failure-'));
  const manifest = path.join(directory, 'app.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      id: 'early',
      package: 'example.package',
      launch: { mode: 'spawn', activity: 'Main', nativeBeforeResume: true },
    })
  );
  try {
    for (const failure of ['spawn', 'original-launch']) {
      const f = fixture(['--app', manifest], failure);
      try {
        await assert.rejects(
          failure === 'spawn' ? f.instance.prepare() : f.instance.launchOriginal(),
          /failed/
        );
        await f.instance.close();
        assert.equal(f.instance.result.ready, false);
        assert.ok(
          f.instance.result.cleanup.actions.some(
            (action: any) => action.action === 'stop-owned-unready-app' && action.passed
          )
        );
      } finally {
        f.close();
      }
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('opt-in native readiness precedes resume and late identity/Java setup; failures never resume an unprepared child', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'af-early-'));
  const manifest = path.join(directory, 'app.json');
  fs.writeFileSync(
    manifest,
    JSON.stringify({
      id: 'early',
      package: 'example.package',
      launch: { mode: 'spawn', nativeBeforeResume: true, activity: 'MainActivity' },
    })
  );
  try {
    for (const failure of ['', 'native', 'native-pid', 'identity']) {
      const f = fixture(
        ['--app', manifest, '--trace', 'system-properties', '--timeout-ms', '500'],
        failure
      );
      try {
        await f.instance.prepare();
        if (failure) {
          await assert.rejects(f.instance.inject());
        } else {
          await f.instance.inject();
          assert.ok(f.calls.indexOf('native-ready') < f.calls.indexOf('resume'));
          assert.ok(f.calls.indexOf('resume') < f.calls.indexOf('java-ready'));
          assert.equal(f.instance.result.nativeStartup.pid, 42);
        }
        await f.instance.close();
        if (failure.startsWith('native')) {
          assert.ok(!f.calls.includes('resume'));
        }
        if (failure === 'identity') {
          assert.ok(!f.calls.includes('java-ready'));
        }
      } finally {
        f.close();
      }
    }
    const f = fixture(['--app', manifest]);
    try {
      await f.instance.launchOriginal();
      assert.equal(f.instance.result.instrumentation, 'none');
      assert.ok(!f.calls.includes('create') && !f.calls.includes('spawn'));
      await f.instance.close();
      assert.equal(f.instance.result.cleanup.complete, true);
    } finally {
      f.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test('wrong main process and partial create failure never claim success and release owned resources', async () => {
  for (const error of ['identity', 'create']) {
    const f = fixture(['--spawn', 'example.package', '--timeout-ms', '500'], error);
    try {
      await assert.rejects(async () => {
        await f.instance.prepare();
        await f.instance.inject();
      });
      await f.instance.close();
      assert.equal(f.instance.result.ready, false);
      if (error === 'identity') {
        assert.ok(!f.calls.includes('load') || !f.instance.result.ready);
      } else {
        assert.ok(f.calls.includes('kill'));
      }
      if (error === 'create') {
        assert.ok(f.calls.includes('detach'));
      }
    } finally {
      f.close();
    }
  }
});
test('disposal failure is retained and the owned process is stopped before script unload', async () => {
  const f = fixture(['--spawn', 'example.package'], 'dispose');
  try {
    await f.instance.prepare();
    await f.instance.inject();
    await f.instance.close();
    assert.equal(f.instance.result.cleanup.complete, false);
    assert.ok(f.calls.indexOf('shell am force-stop example.package') < f.calls.indexOf('unload'));
    assert.match(f.instance.result.errors.join(';'), /in flight/);
  } finally {
    f.close();
  }
});
test('activity launch and custom readiness use the same verified PID and timeout releases forwards', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'af-app-'));
  try {
    const host = path.join(directory, 'host.mjs');
    fs.writeFileSync(host, 'export async function waitReady() { await new Promise(() => {}); }');
    const manifest = path.join(directory, 'app.json');
    fs.writeFileSync(
      manifest,
      JSON.stringify({
        id: 'test-app',
        package: 'example.package',
        launch: { mode: 'activity', activity: 'NativeActivity' },
        host,
      })
    );
    const f = fixture(['--app', manifest, '--timeout-ms', '500']);
    try {
      await assert.rejects(f.instance.prepare(), /readiness timeout/);
      await f.instance.close();
      assert.ok(f.calls.includes('shell am start -n example.package/NativeActivity'));
      assert.ok(f.calls.includes('forward --remove tcp:40001'));
    } finally {
      f.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
