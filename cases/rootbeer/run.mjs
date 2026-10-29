import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import frida from 'frida';
import { build } from 'esbuild';
import { sample } from './catalog.mjs';
import { apkNativeAbis, productionAgent } from '../../scripts/case-artifact.mjs';
export { apkNativeAbis, productionAgent } from '../../scripts/case-artifact.mjs';
import { evaluateRun, renderReport } from './result.mjs';
import { readUiAttribute, readCompletedRootBeerUi } from './ui-xml.mjs';
import { waitReady as waitForDetectEnv } from '../../apps/detect-env-duck/host.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(directory, '../..');
const repository = workspace;
const lock = JSON.parse(
  fs.readFileSync(path.join(workspace, 'test/api33/toolchain.lock.json'), 'utf8')
);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const observe = { mode: 'observe', captureStack: true };
const positive = JSON.parse(fs.readFileSync(path.join(directory, 'positive.json'), 'utf8'));
const negative = JSON.parse(fs.readFileSync(path.join(directory, 'negative.json'), 'utf8'));
const reusePackage = 'com.detect.app.sample';

export function targetForAbi(abi, specification = lock) {
  const architectures = { x86_64: ['x86_64', 'x64'], 'arm64-v8a': ['arm64', 'arm64'] };
  const expected = architectures[abi];
  const target = specification.targets?.[abi];
  if (
    specification.schemaVersion !== 2 ||
    !expected ||
    !target ||
    target.serverArch !== expected[0] ||
    target.processArch !== expected[1] ||
    !['serverSha256', 'serverArchiveSha256'].every(field => /^[a-f0-9]{64}$/.test(target[field]))
  ) {
    throw new Error('Unsupported or invalid locked ABI: ' + abi);
  }
  return { ...target, abi };
}

export function checkTargetIdentity(info, packageName, target) {
  if (info.package !== packageName || info.sdk !== 33 || info.arch !== target.processArch) {
    throw new Error('Unexpected target identity: ' + JSON.stringify(info));
  }
}

export function options(argv) {
  if (argv.includes('--help')) {
    console.log(
      'case:rootbeer --apk <RootBeer-0.9.apk> --serial <adb-serial> [--reuse-detect-env] ' +
        '[--abi x86_64|arm64-v8a] [--agent <js> --production-manifest <json>] [--output <new-directory>]'
    );
    return null;
  }
  const result = { reuse: false };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--reuse-detect-env') {
      result.reuse = true;
      continue;
    }
    if (
      !['--apk', '--serial', '--abi', '--agent', '--production-manifest', '--output'].includes(
        flag
      ) ||
      !argv[index + 1] ||
      argv[index + 1].startsWith('--') ||
      result[flag.slice(2)]
    ) {
      throw new Error('Invalid, duplicate or incomplete argument: ' + flag);
    }
    result[flag.slice(2)] = argv[++index];
  }
  if (!result.apk || !result.serial) {
    throw new Error('--apk and --serial are required');
  }
  result.abi ??= 'x86_64';
  targetForAbi(result.abi);
  if (Boolean(result.agent) !== Boolean(result['production-manifest'])) {
    throw new Error('--agent and --production-manifest must be supplied together');
  }
  result.apk = path.resolve(result.apk);
  for (const field of ['agent', 'production-manifest', 'output']) {
    if (result[field]) {
      result[field] = path.resolve(result[field]);
    }
  }
  return result;
}

export function outputDirectory(requested) {
  if (requested) {
    fs.mkdirSync(path.dirname(requested), { recursive: true });
    fs.mkdirSync(requested); // Refuse even an empty existing directory.
    return requested;
  }
  const root = path.join(repository, '.runtime/frida/cases/rootbeer');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
}

async function main(args) {
  const output = outputDirectory(args.output);
  const targetSpec = targetForAbi(args.abi);
  const run = {
    schemaVersion: 3,
    requestedAbi: args.abi,
    sample,
    agentSource: args.agent ? 'production-artifact' : 'local-build',
    environment: { serial: args.serial, apk: args.apk },
    startedAt: new Date().toISOString(),
    phases: {},
    afterUnload: [],
    reuse: { requested: args.reuse, phases: {} },
    errors: [],
    cleanup: { complete: false, actions: [] },
  };
  const log = (message, detail) => {
    const line =
      new Date().toISOString() +
      ' ' +
      message +
      (detail === undefined ? '' : ' ' + JSON.stringify(detail));
    fs.appendFileSync(path.join(output, 'run.log'), line + '\n');
    console.log(line);
  };
  const startup = new AbortController();
  let interruptRun;
  const interrupted = new Promise((_, reject) => {
    interruptRun = () => {
      startup.abort();
      reject(new Error('Run interrupted'));
    };
  });
  process.once('SIGINT', interruptRun);
  process.once('SIGTERM', interruptRun);
  async function bounded(promise, label, cleanup = false) {
    let timer;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' timed out')), 40000);
        }),
        ...(cleanup ? [] : [interrupted]),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  function adb(argv, binary = false) {
    const result = spawnSync('adb', ['-s', args.serial, ...argv], {
      encoding: binary ? undefined : 'utf8',
      timeout: 60000,
      maxBuffer: 24 * 1024 * 1024,
      windowsHide: true,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        'adb ' + argv[0] + ' failed: ' + (result.error?.message ?? result.stderr ?? result.stdout)
      );
    }
    return binary ? result.stdout : result.stdout.trim();
  }
  function installedHash(packageName, libraries) {
    const paths = adb(['shell', 'pm', 'path', packageName]).split(/\r?\n/);
    if (paths.length !== 1 || !paths[0].startsWith('package:')) {
      throw new Error('Expected one installed base APK for ' + packageName);
    }
    const digest = adb(['shell', 'sha256sum', paths[0].slice(8)]).split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(digest)) {
      throw new Error('Could not hash installed APK for ' + packageName);
    }
    if (libraries) {
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'agentforge-apk-abi-'));
      try {
        const apk = path.join(temporary, 'installed.apk');
        adb(['pull', paths[0].slice(8), apk]);
        const bytes = fs.readFileSync(apk);
        const abis = libraries
          .map(library => apkNativeAbis(bytes, library))
          .reduce((shared, available) => shared.filter(abi => available.includes(abi)));
        if (sha256(bytes) !== digest || !abis.includes(args.abi)) {
          throw new Error('Installed APK hash/native ABI mismatch for ' + packageName);
        }
        run.reuse.apkAbis = abis;
      } finally {
        fs.rmSync(temporary, { recursive: true, force: true });
      }
    }
    return digest;
  }
  let reuseHttpPort = null;
  let port = null,
    manager = null,
    device = null,
    session = null,
    api = null,
    ownedPid = null;
  let activePackage = sample.package;
  let apiSource;
  async function clean(action, operation) {
    try {
      await operation();
      run.cleanup.actions.push({ action, passed: true });
    } catch (error) {
      run.cleanup.actions.push({ action, passed: false, error: String(error) });
      run.errors.push(action + ': ' + error);
    }
  }
  async function close() {
    if (api !== null) {
      await clean('observer.dispose', () =>
        bounded(api.exports.disposeobserver(), 'observer dispose', true)
      );
      await clean('api.dispose', () => bounded(api.exports.dispose(), 'api dispose', true));
      await clean('agent.unload', () => bounded(api.unload(), 'agent unload', true));
    }
    api = null;
    if (session !== null) {
      const previous = session;
      session = null;
      await clean('session.detach', () => bounded(previous.detach(), 'detach', true));
    }
  }
  async function loadScript(source, name) {
    const script = await bounded(session.createScript(source, { name }), 'create ' + name);
    script.message.connect(message => {
      if (message.type === 'error') {
        run.errors.push(message.stack ?? message.description);
        log(name + ' error', message);
      } else if (message.payload?.type === 'trace-event') {
        fs.appendFileSync(
          path.join(output, 'events.jsonl'),
          JSON.stringify({
            package: activePackage,
            ...message.payload.event,
          }) + '\n'
        );
      }
    });
    script.logHandler = (level, text) => log(name + '/' + level, text);
    await bounded(script.load(), 'load ' + name);
    return script;
  }
  async function open(packageName, observerName) {
    activePackage = packageName;
    adb(['shell', 'am', 'force-stop', packageName]);
    const activityLaunch = packageName === reusePackage;
    if (activityLaunch) {
      const app = JSON.parse(
        fs.readFileSync(path.join(workspace, 'apps/detect-env-duck/app.json'), 'utf8')
      );
      adb(['shell', 'am', 'start', '-W', '-n', `${packageName}/${app.launch.activity}`]);
      const pid = adb(['shell', 'pidof', packageName]);
      if (!/^\d+$/.test(pid)) {
        throw new Error('detect-env did not start exactly one main process');
      }
      ownedPid = Number(pid);
      if (adb(['shell', 'cat', `/proc/${ownedPid}/cmdline`]).split('\0')[0] !== packageName) {
        throw new Error('detect-env PID belongs to a different process');
      }
      reuseHttpPort = adb(['forward', 'tcp:0', 'tcp:5566']);
      const deadline = Date.now() + 35000;
      await bounded(
        waitForDetectEnv(
          {
            adb,
            log,
            signal: startup.signal,
            httpBase: 'http://127.0.0.1:' + reuseHttpPort,
            remainingMs: () => Math.max(0, deadline - Date.now()),
          },
          { pid: ownedPid }
        ),
        'detect-env original NativeActivity readiness'
      );
      run.reuse.startup = {
        mode: 'activity-then-attach',
        pid: ownedPid,
        readyBeforeInjection: true,
      };
    } else {
      ownedPid = await bounded(device.spawn([packageName]), 'spawn ' + packageName);
    }
    session = await bounded(device.attach(ownedPid), 'attach ' + packageName);
    // One Script and one bridge own ART patches. The identical public API bundle
    // is followed by the target's read-only UI adapter in that same runtime.
    const source =
      apiSource + '\n' + fs.readFileSync(path.join(output, observerName + '.js'), 'utf8');
    api = await loadScript(source, observerName);
    if (!activityLaunch) {
      await bounded(device.resume(ownedPid), 'resume ' + packageName);
    }
    await bounded(api.exports.configure(observe), 'observe APIs');
    const info = await bounded(api.exports.init(), 'initialize ' + observerName);
    checkTargetIdentity(info, packageName, targetSpec);
    log('target', info);
    return { ...info, apiAgentSha256: sha256(apiSource), scriptSha256: sha256(source) };
  }
  async function snapshot(target, name, policy) {
    log(activePackage + ' phase ' + name);
    const configuration = await bounded(api.exports.configure(policy), name + ' configure');
    const tap = await bounded(api.exports.prepareui(), name + ' locate original UI control');
    await bounded(api.exports.drain(), 'discard configuration traffic');
    adb(['shell', 'input', 'tap', String(tap.x), String(tap.y)]);
    const ui = await bounded(api.exports.ui(), name + ' original UI action');
    const trace = await bounded(api.exports.drain(), name + ' collect API observations');
    target[name] = { policy, configuration, ui, ...trace };
    fs.writeFileSync(
      path.join(output, (activePackage === sample.package ? '' : 'reuse-') + name + '.png'),
      adb(['exec-out', 'screencap', '-p'], true)
    );
    log(name + ' result', {
      rooted: ui.rooted,
      checks: ui.checks,
      result: ui.result,
      apiCalls: trace.records.length,
      dropped: trace.dropped,
    });
  }
  async function closeAndRecheck(baseline) {
    const pid = ownedPid;
    const packageName = activePackage;
    const tap = await bounded(api.exports.prepareui(), 'locate post-unload control');
    await close();
    const observation = { package: packageName, pid, rounds: [], passed: false };
    run.afterUnload.push(observation);
    // Exercise the original UI after the Java bridge itself is gone. Two runs
    // also expose deferred finalizer/ART failures that an RPC cleanup misses.
    for (let round = 0; round < 2; round++) {
      if (round && packageName === reusePackage) {
        adb(['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
      }
      adb(['shell', 'input', 'tap', String(tap.x), String(tap.y)]);
      const completionDeadline = Date.now() + 25000;
      await new Promise(resolve => setTimeout(resolve, 8000));
      for (;;) {
        if (adb(['shell', 'pidof', packageName]) !== String(pid)) {
          throw new Error(packageName + ' terminated/restarted after script unload');
        }
        const remote = '/data/local/tmp/agentforge-case-window.xml';
        try {
          adb(['shell', 'uiautomator', 'dump', remote]);
          const xml = adb(['shell', 'cat', remote]);
          fs.writeFileSync(path.join(output, 'after-unload-' + pid + '-' + round + '.xml'), xml);
          let result;
          if (packageName === sample.package) {
            result = readCompletedRootBeerUi(xml, baseline.checks.length);
            if (result === null) {
              if (Date.now() >= completionDeadline) {
                throw new Error('Post-unload RootBeer UI did not finish');
              }
              await new Promise(resolve => setTimeout(resolve, 250));
              continue;
            }
            if (result !== baseline.text) {
              throw new Error('Post-unload RootBeer UI did not restore baseline');
            }
          } else {
            const node = xml.match(/<node\b[^>]*class="android\.widget\.EditText"[^>]*>/)?.[0];
            const text = readUiAttribute(node, 'text');
            result = text === null ? null : JSON.parse(text);
            if (JSON.stringify(result) !== JSON.stringify(baseline.result)) {
              throw new Error('Post-unload detect-env UI did not restore baseline');
            }
          }
          observation.rounds.push({ pid, result });
          break;
        } finally {
          adb(['shell', 'rm', '-f', remote]);
        }
      }
    }
    observation.passed = true;
    log('post-unload UI restored', observation);
  }
  try {
    log('output', output);
    if (args.agent) {
      const production = productionAgent(args.agent, args['production-manifest']);
      apiSource = production.source;
      fs.writeFileSync(
        path.join(output, 'production-manifest.json'),
        JSON.stringify(production.manifest, null, 2) + '\n'
      );
    } else {
      await import('../../scripts/build-api-agent.mjs');
      apiSource = fs.readFileSync(path.join(workspace, 'dist/android-api.js'), 'utf8');
    }
    run.apiAgentSha256 = sha256(apiSource);
    fs.writeFileSync(path.join(output, 'android-api.js'), apiSource);
    const apkBytes = fs.readFileSync(args.apk);
    const digest = sha256(apkBytes);
    if (digest !== sample.sha256) {
      throw new Error('RootBeer APK SHA256 mismatch');
    }
    run.environment.apkAbis = apkNativeAbis(apkBytes, 'libtool-checker.so');
    if (!run.environment.apkAbis.includes(args.abi)) {
      throw new Error('RootBeer APK does not contain the requested native ABI');
    }
    const client = JSON.parse(
      fs.readFileSync(path.join(workspace, 'node_modules/frida/package.json'), 'utf8')
    ).version;
    const sdk = adb(['shell', 'getprop', 'ro.build.version.sdk']);
    const abi = adb(['shell', 'getprop', 'ro.product.cpu.abi']);
    if (client !== lock.fridaVersion || sdk !== '33' || abi !== args.abi) {
      throw new Error(
        'Expected locked Frida ' +
          lock.fridaVersion +
          ', API 33 ' +
          args.abi +
          '; found ' +
          client +
          '/' +
          sdk +
          '/' +
          abi
      );
    }
    const serverPid = adb(['shell', 'pidof', 'agentforge-frida-server']);
    if (!/^\d+$/.test(serverPid)) {
      throw new Error('Expected one running agentforge-frida-server');
    }
    const executable = '/proc/' + serverPid + '/exe';
    const serverVersion = adb(['shell', executable, '--version']);
    const serverSha256 = adb(['shell', 'sha256sum', executable]).split(/\s+/)[0];
    if (serverVersion !== lock.fridaVersion || serverSha256 !== targetSpec.serverSha256) {
      throw new Error('Running server binary does not match the lock');
    }
    log('install', adb(['install', '-r', args.apk]));
    const installed = installedHash(sample.package);
    if (installed !== digest) {
      throw new Error('Installed RootBeer APK differs from supplied sample');
    }
    Object.assign(run.environment, {
      sdk: 33,
      abi,
      serverArch: targetSpec.serverArch,
      node: process.versions.node,
      frida: client,
      serverVersion,
      serverSha256,
      installedSha256: installed,
    });
    if (args.reuse) {
      run.reuse.apkSha256 = installedHash(reusePackage, [
        'libdetect_sample.so',
        'libasm_module.so',
      ]);
    }
    for (const name of ['agent', ...(args.reuse ? ['detect-env-observer'] : [])]) {
      await build({
        entryPoints: [path.join(directory, name + '.ts')],
        outfile: path.join(output, name + '.js'),
        bundle: true,
        format: 'iife',
        platform: 'neutral',
        target: 'es2020',
        sourcemap: 'inline',
        tsconfig: path.join(workspace, 'tsconfig.agent.json'),
        plugins: [
          {
            name: 'share-public-api-java-bridge',
            setup(builder) {
              builder.onResolve({ filter: /runtime\/java-bridge$/ }, () => ({
                path: 'java',
                namespace: 'case-bridge',
              }));
              builder.onLoad({ filter: /.*/, namespace: 'case-bridge' }, () => ({
                contents:
                  'export const { Java, initializeJavaClassLoader, performOnJava } = AgentForgeAndroidApi;',
                loader: 'js',
              }));
            },
          },
        ],
      });
    }
    adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    adb(['shell', 'wm', 'dismiss-keyguard']);
    port = adb(['forward', 'tcp:0', 'tcp:27042']);
    if (!/^\d+$/.test(port)) {
      throw new Error('adb did not allocate a forwarding port');
    }
    manager = frida.getDeviceManager();
    device = await bounded(manager.addRemoteDevice('127.0.0.1:' + port), 'connect server');
    run.environment.target = await open(sample.package, 'agent');
    run.environment.processArch = run.environment.target.arch;
    if (run.environment.target.version !== sample.version) {
      throw new Error('Unexpected RootBeer version');
    }
    await snapshot(run.phases, 'observe', observe);
    await snapshot(run.phases, 'positive', positive);
    await snapshot(run.phases, 'negative', negative);
    await snapshot(run.phases, 'restored', observe);
    await closeAndRecheck(run.phases.observe.ui);
    const previousPid = ownedPid;
    ownedPid = null;
    await bounded(device.kill(previousPid), 'stop first process');
    await open(sample.package, 'agent');
    await snapshot(run.phases, 'cold', observe);
    await closeAndRecheck(run.phases.observe.ui);
    ownedPid = null; // successful cold App remains open, with its script removed
    if (args.reuse) {
      run.reuse.target = await open(reusePackage, 'detect-env-observer');
      for (const [name, policy] of [
        ['observe', observe],
        ['positive', positive],
        ['negative', negative],
        ['restored', observe],
      ]) {
        await snapshot(run.reuse.phases, name, policy);
      }
      await closeAndRecheck(run.reuse.phases.observe.ui);
      ownedPid = null;
    }
  } catch (error) {
    run.errors.push(error.stack ?? String(error));
    log('failed', error.stack ?? String(error));
  } finally {
    startup.abort();
    await close();
    if (ownedPid !== null && device !== null) {
      await clean('stop-failed-owned-process', () =>
        bounded(device.kill(ownedPid), 'stop failed process', true)
      );
    }
    if (manager && device) {
      await clean('remove-frida-remote', () =>
        bounded(manager.removeRemoteDevice('127.0.0.1:' + port), 'remove remote', true)
      );
    }
    if (port !== null) {
      await clean('remove-own-adb-forward', () => {
        adb(['forward', '--remove', 'tcp:' + port]);
      });
    }
    if (reuseHttpPort !== null) {
      await clean('remove-own-detect-env-http-forward', () => {
        adb(['forward', '--remove', 'tcp:' + reuseHttpPort]);
      });
    }
    process.removeListener('SIGINT', interruptRun);
    process.removeListener('SIGTERM', interruptRun);
    run.cleanup.complete = run.cleanup.actions.every(action => action.passed);
    run.finishedAt = new Date().toISOString();
    run.evaluation = evaluateRun(run);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(run, null, 2) + '\n');
    fs.writeFileSync(path.join(output, 'report.md'), renderReport(run));
    log(run.evaluation.passed ? 'PASS' : 'FAIL', run.evaluation.failures);
    console.log('Results: ' + output);
  }
  return run.evaluation.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = options(process.argv.slice(2));
    process.exitCode = args ? await main(args) : 0;
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
