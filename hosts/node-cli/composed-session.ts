import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import type { Plan } from './composition';
import { boundedOperation, attachScript } from './session-utils';

export type AppHostContext = {
  serial: string;
  package?: string;
  process?: string;
  httpBase?: string;
  adb: (argv: string[], binary?: boolean) => any;
  log: (message: string, detail?: unknown) => void;
  signal: AbortSignal;
  remainingMs: () => number;
  forward: (port: number) => number;
  defer: (cleanup: () => void | Promise<void>) => void;
};

export function createSession(
  plan: Plan,
  output: string,
  source: string,
  dependencies: {
    manager?: ReturnType<typeof frida.getDeviceManager>;
    adb?: (argv: string[], binary: boolean) => any;
  } = {}
) {
  const args = plan.options;
  const result: any = { errors: [], cleanup: { complete: false, actions: [] }, ready: false };
  const manager = dependencies.manager ?? frida.getDeviceManager();
  const forwards: string[] = [];
  const resources: (() => void | Promise<void>)[] = [];
  let device: frida.Device | undefined;
  let session: frida.Session | undefined;
  let script: frida.Script | undefined;
  let remote: string | undefined;
  let expectedDetach = false;
  let pid: number | undefined;
  let targetPackage =
    plan.app?.package ??
    args.spawn ??
    (args.attach && !/^\d+$/.test(args.attach) ? args.attach : undefined);
  let ownedProcess = false;
  let suspended = false;
  let deadline = Date.now() + args.timeoutMs;
  let closed = false;
  let appReady = false;
  const cancellation = new AbortController();
  const log = (message: string, detail?: unknown) => {
    const line =
      new Date().toISOString() +
      ' ' +
      message +
      (detail === undefined ? '' : ' ' + JSON.stringify(detail));
    fs.appendFileSync(path.join(output, 'run.log'), line + '\n');
    console.log(line);
  };
  const event = (value: unknown) =>
    fs.appendFileSync(path.join(output, 'events.jsonl'), JSON.stringify(value) + '\n');
  function adb(argv: string[], binary = false): any {
    if (dependencies.adb) {
      return dependencies.adb(argv, binary);
    }
    const response = spawnSync('adb', ['-s', args.serial!, ...argv], {
      encoding: binary ? undefined : 'utf8',
      windowsHide: true,
      timeout: result.ready ? 60000 : Math.max(1, Math.min(60000, deadline - Date.now())),
      maxBuffer: 24 * 1024 * 1024,
    });
    if (response.error || response.status !== 0) {
      throw new Error(
        'adb ' + argv[0] + ': ' + (response.error?.message ?? response.stderr ?? response.stdout)
      );
    }
    return binary ? response.stdout : String(response.stdout).trim();
  }
  async function bounded<T>(work: Promise<T>, label: string, cleanup = false): Promise<T> {
    return boundedOperation(
      () => work,
      label,
      cleanup ? 10000 : deadline - Date.now(),
      cleanup ? undefined : cancellation.signal
    );
  }

  function verifyPid(value = pid) {
    if (!value || !Number.isInteger(value)) {
      throw new Error('Missing target PID');
    }
    const name = adb(['exec-out', 'cat', '/proc/' + value + '/cmdline'], true)
      .toString()
      .split('\0')[0];
    const expected = plan.app?.process ?? targetPackage;
    if (expected && name !== expected) {
      throw new Error('Target process differs: ' + name + ' != ' + expected);
    }
    if (!expected) {
      targetPackage = name;
    }
    const ids = adb(['shell', 'pidof', expected ?? name]).split(/\s+/);
    if (!ids.includes(String(value))) {
      throw new Error('Target PID no longer belongs to expected process');
    }
    return { pid: value, process: name, package: targetPackage };
  }
  const ctx: AppHostContext = {
    serial: args.serial!,
    package: plan.app?.package,
    process: plan.app?.process,
    adb,
    log,
    signal: cancellation.signal,
    remainingMs: () => Math.max(0, deadline - Date.now()),
    forward(port: number) {
      const value = adb(['forward', 'tcp:0', 'tcp:' + port]);
      if (!/^\d+$/.test(value)) {
        throw new Error('Cannot allocate owned forward');
      }
      forwards.push(value);
      return Number(value);
    },
    defer(cleanup: () => void | Promise<void>) {
      resources.push(cleanup);
    },
  };
  let host: any;
  async function prepare() {
    log('preparing target');
    deadline = Date.now() + args.timeoutMs;
    if (plan.app?.host) {
      host = await bounded(import(pathToFileURL(plan.app.host).href), 'App Host import');
    }
    if (plan.app?.launch.nativeBeforeResume && host?.launch) {
      throw new Error('nativeBeforeResume cannot use custom Host launch');
    }
    // Allocate only this run's forwards. Existing server/device are borrowed.
    const port = ctx.forward(27042);
    remote = '127.0.0.1:' + port;
    device = await bounded(manager.addRemoteDevice(remote), 'Frida connection');
    log('Frida connected', { serial: args.serial });
    return launchTarget();
  }
  function startActivity() {
    targetPackage = plan.app!.package;
    adb(['shell', 'am', 'force-stop', targetPackage]);
    ownedProcess = true;
    const launch = adb([
      'shell',
      'am',
      'start',
      '-n',
      targetPackage + '/' + plan.app!.launch.activity,
      // A launcher intent may otherwise only bring an old task's external
      // browser to front, without creating the requested App process. Original
      // cold launches reset this App task; no package data is cleared.
      ...(plan.app!.launch.nativeBeforeResume ? ['-f', '0x10008000'] : []),
    ]);
    if (/Error:|Error type|Exception/.test(launch)) {
      throw new Error('Activity launch failed: ' + launch);
    }
  }
  async function launchTarget(original = false) {
    pid = undefined;
    appReady = false;
    if (original) {
      startActivity();
    } else if (host?.launch) {
      const launched = await bounded(Promise.resolve(host.launch(ctx)), 'App launch');
      pid = typeof launched === 'number' ? launched : launched?.pid;
      ownedProcess = true;
    } else if (args.spawn || plan.app?.launch.mode === 'spawn') {
      targetPackage = args.spawn ?? plan.app!.package;
      if (plan.app?.launch.nativeBeforeResume) {
        adb(['shell', 'am', 'force-stop', targetPackage]);
        ownedProcess = true;
      }
      const spawnOptions = plan.app?.launch.activity
        ? { aux: { activity: plan.app.launch.activity } }
        : {};
      pid = await bounded(device!.spawn([targetPackage], spawnOptions), 'spawn');
      ownedProcess = true;
      suspended = true;
    } else if (plan.app?.launch.mode === 'activity') {
      startActivity();
    } else if (args.attach) {
      pid = /^\d+$/.test(args.attach)
        ? Number(args.attach)
        : Number(adb(['shell', 'pidof', args.attach]));
    }
    if (original || (!suspended && plan.app?.launch.mode === 'activity')) {
      while (Date.now() < deadline) {
        try {
          pid = Number(adb(['shell', 'pidof', plan.app!.process]));
          if (pid) {
            break;
          }
        } catch {
          /* process startup */
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    // Android spawn may suspend before specialization: /proc/cmdline can still
    // contain a fork parent's name. Only explicitly selected early native APIs
    // may activate before resume; Java/managed entries require exact identity.
    const target = suspended
      ? { pid: pid!, process: targetPackage!, package: targetPackage, verified: false }
      : { ...verifyPid(), verified: true };
    if (!suspended && host?.waitReady) {
      await bounded(Promise.resolve(host.waitReady(ctx, target)), 'App readiness');
      appReady = true;
    }
    result.target = target;
    log('target prepared', target);
    return target;
  }
  async function inject() {
    if (!device || !pid || script) {
      throw new Error('Prepare target before injecting once');
    }
    if (!suspended) {
      verifyPid();
    }
    expectedDetach = false;
    script = (await attachScript(
      device,
      pid,
      source,
      'af-frida',
      (op, label) => bounded(op(), label),
      owned => {
        session = owned;
        session!.detached.connect(reason => {
          if (!expectedDetach) {
            result.errors.push('Unexpected detach: ' + reason);
            cancellation.abort();
          }
        });
      }
    )) as frida.Script;
    script.message.connect(message => {
      event(message);
      if (message.type === 'error') {
        result.errors.push(message.stack ?? message.description);
        log('agent error', message);
      } else if (message.payload?.type === 'composition-error') {
        result.errors.push(message.payload.error);
      }
    });
    script.logHandler = (level, message) => log('agent/' + level, message);
    await bounded(script.load(), 'load');
    let drainTimer: NodeJS.Timeout | undefined;
    let draining: Promise<void> | undefined;
    if (suspended && plan.app?.launch.nativeBeforeResume) {
      const receipt = await bounded(script.exports.preparenative(), 'native preparation');
      if (
        receipt.pid !== pid ||
        !Number.isFinite(receipt.readyAt) ||
        !Array.isArray(receipt.installed)
      ) {
        throw new Error('Invalid pre-resume native receipt');
      }
      result.nativeStartup = receipt;
      log('native capabilities ready before resume', receipt);
      drainTimer = setInterval(() => {
        if (draining) {
          return;
        }
        draining = (async () => {
          const batch = await bounded(script!.exports.drain(), 'startup observations');
          event({ type: 'startup-observations', ...batch });
          if (batch.dropped || batch.records.some((item: any) => item.runtimeError)) {
            throw new Error('Startup observation integrity failed');
          }
        })()
          .catch(error => {
            result.errors.push(String(error));
            cancellation.abort();
          })
          .finally(() => {
            draining = undefined;
          });
      }, 100);
    }
    try {
      if (suspended) {
        await bounded(device.resume(pid), 'resume');
        suspended = false;
        let lastError: unknown;
        while (Date.now() < deadline) {
          try {
            result.target = { ...verifyPid(), verified: true };
            lastError = undefined;
            break;
          } catch (error) {
            lastError = error;
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (lastError) {
          throw lastError;
        }
        if (result.target?.verified !== true) {
          throw new Error('Spawn identity verification timed out');
        }
      }
      result.installation = await bounded(script.exports.start(), 'capability activation');
    } finally {
      clearInterval(drainTimer);
      await draining;
    }
    verifyPid();
    if (host?.waitReady && !appReady) {
      await bounded(Promise.resolve(host.waitReady(ctx, result.target)), 'App readiness');
    }
    result.ready = true;
    result.instrumentation = 'composition';
    const ready = {
      type: 'ready',
      target: result.target,
      installation: result.installation,
      httpBase: ctx.httpBase,
    };
    event(ready);
    log('capabilities ready', ready);
    return script.exports;
  }
  async function clean(action: string, operation: () => unknown) {
    try {
      await operation();
      result.cleanup.actions.push({ action, passed: true });
      return true;
    } catch (error) {
      result.errors.push(action + ': ' + error);
      result.cleanup.actions.push({ action, passed: false, error: String(error) });
      return false;
    }
  }
  async function unload() {
    if (script) {
      const safe = await clean('api.dispose', async () => {
        const response = await bounded(script!.exports.dispose(), 'dispose', true);
        if (response?.restored !== true) {
          throw new Error('Restoration not confirmed');
        }
        result.finalInstallation = await bounded(script!.exports.status(), 'status', true);
        const observations = await bounded(script!.exports.drain(), 'final drain', true);
        event({ type: 'final-observations', ...observations });
        if (
          observations.dropped ||
          observations.records.some((item: any) => item.runtimeError) ||
          result.finalInstallation.counts.runtimeErrors
        ) {
          throw new Error('Observation integrity failed');
        }
      });
      if (!safe && ownedProcess && targetPackage) {
        await clean('stop-owned-before-unsafe-unload', () =>
          adb(['shell', 'am', 'force-stop', targetPackage!])
        );
      }
      await clean('script.unload', () => bounded(script!.unload(), 'unload', true));
      script = undefined;
    }
    if (session) {
      expectedDetach = true;
      await clean('session.detach', () => bounded(session!.detach(), 'detach', true));
      session = undefined;
    }
    return !result.cleanup.actions.some((item: any) => !item.passed);
  }
  async function close() {
    if (closed) {
      return result;
    }
    closed = true;
    deadline = Date.now() + 60000;
    await unload();
    if ((suspended || (!result.ready && ownedProcess)) && device && pid) {
      await clean('kill-unready-owned-process', async () => {
        try {
          await device!.kill(pid!);
        } catch (error) {
          const current = adb(['shell', 'pidof', targetPackage!]).split(/\s+/);
          if (current.includes(String(pid))) {
            throw error;
          }
        }
      });
    }
    if (ownedProcess && !result.ready && targetPackage && (!device || !pid)) {
      await clean('stop-owned-unready-app', () =>
        adb(['shell', 'am', 'force-stop', targetPackage!])
      );
    }
    for (const cleanup of resources.reverse()) {
      await clean('App resource', cleanup);
    }
    if (remote && device) {
      await clean('remove Frida remote', () =>
        bounded(manager.removeRemoteDevice(remote!), 'remove remote', true)
      );
    }
    for (const port of forwards.reverse()) {
      await clean('remove own forward ' + port, () => adb(['forward', '--remove', 'tcp:' + port]));
    }
    result.cleanup.complete = result.cleanup.actions.every((item: any) => item.passed);
    return result;
  }
  return {
    prepare,
    inject,
    unload,
    close,
    async drain() {
      const batch = await boundedOperation(
        () => script!.exports.drain(),
        'API observations',
        10000,
        cancellation.signal
      );
      event({ type: 'api-observations', ...batch });
      if (
        result.errors.length ||
        batch.dropped ||
        batch.records.some((item: any) => item.runtimeError)
      ) {
        throw new Error('API observation integrity failed');
      }
      return batch;
    },
    verifyPid,
    async launchOriginal() {
      if (script || session || device || !plan.app?.launch.activity) {
        throw new Error('Original launch needs an unused App session and declared Activity');
      }
      deadline = Date.now() + args.timeoutMs;
      if (plan.app.host) {
        host = await bounded(import(pathToFileURL(plan.app.host).href), 'App Host import');
      }
      const target = await launchTarget(true);
      result.ready = true;
      result.instrumentation = 'none';
      return target;
    },
    async coldStart() {
      if (script || session || !plan.app || plan.app.launch.mode !== 'activity') {
        throw new Error('Cold start requires an unloaded activity App');
      }
      deadline = Date.now() + args.timeoutMs;
      return launchTarget();
    },
    installApk(apk: string) {
      if (!targetPackage) {
        throw new Error('APK install needs a declared package');
      }
      const hash = createHash('sha256').update(fs.readFileSync(apk)).digest('hex');
      log('install APK', adb(['install', '-r', apk]));
      const installed = adb(['shell', 'pm', 'path', targetPackage]).split(/\r?\n/);
      if (installed.length !== 1 || !installed[0].startsWith('package:')) {
        throw new Error('Expected one installed base APK for ' + targetPackage);
      }
      const actual = adb(['shell', 'sha256sum', installed[0].slice(8)]).split(/\s+/)[0];
      if (actual !== hash) {
        throw new Error('Installed APK differs from input');
      }
      return { apk, apkSha256: hash, installedSha256: actual };
    },
    environment() {
      const serverPid = adb(['shell', 'pidof', 'agentforge-frida-server']);
      if (!/^\d+$/.test(serverPid)) {
        throw new Error('Expected one running locked agentforge-frida-server');
      }
      const exe = '/proc/' + serverPid + '/exe';
      return {
        api: Number(adb(['shell', 'getprop', 'ro.build.version.sdk'])),
        abi: adb(['shell', 'getprop', 'ro.product.cpu.abi']),
        serverVersion: adb(['shell', exe, '--version']),
        serverSha256: adb(['shell', 'sha256sum', exe]).split(/\s+/)[0],
        node: process.version,
      };
    },
    adb,
    ctx,
    result,
    log,
    cancel: () => cancellation.abort(),
    get exports() {
      if (!script) {
        throw new Error('Script is not loaded');
      }
      return script.exports;
    },
    get target() {
      return verifyPid();
    },
  };
}
