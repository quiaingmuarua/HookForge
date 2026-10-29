import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import frida from 'frida';
import { build } from 'esbuild';
import { apkNativeAbis, productionAgent } from '../../scripts/case-artifact.mjs';
import { sdk, packageName, eventCode, risk, normal, observe } from './spec.mjs';
import { readSnapshot, evaluateRun, renderReport } from './result.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(directory, '../..');
const repository = workspace;
const lock = JSON.parse(
  fs.readFileSync(path.join(workspace, 'test/api33/toolchain.lock.json'), 'utf8')
);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function options(
  argv,
  base = process.env.INIT_CWD || process.cwd(),
  label = 'case:duck-system-properties'
) {
  if (argv.includes('--help')) {
    console.log(
      label +
        ' --apk <detect-env.apk> --serial <adb-serial> [--agent <js> --production-manifest <json>] [--output <new-directory>]'
    );
    return null;
  }
  const result = {};
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (
      !['--apk', '--serial', '--agent', '--production-manifest', '--output'].includes(flag) ||
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
  if (Boolean(result.agent) !== Boolean(result['production-manifest'])) {
    throw new Error('--agent and --production-manifest must be supplied together');
  }
  for (const field of ['apk', 'agent', 'production-manifest', 'output']) {
    if (result[field]) {
      result[field] = path.resolve(base, result[field]);
    }
  }
  return result;
}

export function outputDirectory(requested) {
  if (requested) {
    fs.mkdirSync(path.dirname(requested), { recursive: true });
    fs.mkdirSync(requested);
    return requested;
  }
  const root = path.join(repository, '.runtime/frida/cases/duck-system-properties');
  fs.mkdirSync(root, { recursive: true });
  return fs.mkdtempSync(path.join(root, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
}

// All byte/provenance checks run before any ADB operation, including install.
export function preflight(args) {
  const agent = args.agent ? productionAgent(args.agent, args['production-manifest']) : null;
  const bytes = fs.readFileSync(args.apk);
  if (!apkNativeAbis(bytes, 'libduckdetector.so').includes('x86_64')) {
    throw new Error('Supplied APK lacks the original Duck x86_64 library');
  }
  return { agent, apkSha256: sha256(bytes) };
}

export function mainActivityReady(activity) {
  return /(?:mResumedActivity:|ResumedActivity:|topResumedActivity=).*com\.detect\.app\.sample\/[^\s}]*DetectEnvMainActivity/.test(
    activity
  );
}

export async function main(args) {
  const output = outputDirectory(args.output);
  const run = {
    schemaVersion: 1,
    agentSource: args.agent ? 'production-artifact' : 'local-build',
    startedAt: new Date().toISOString(),
    sdk: { tag: sdk.tag, commit: sdk.commit, aarSha256: sdk.sha256 },
    environment: { serial: args.serial, apk: args.apk },
    phases: {},
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
  const writeJson = (file, value) =>
    fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + '\n');
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error('Run interrupted'));
  process.once('SIGINT', interrupt);
  process.once('SIGTERM', interrupt);
  let manager, device, session, script;
  let fridaPort, httpPort, pid;
  let expectedDetach = false;
  let startedApp = false;
  let completed = false;
  async function bounded(promise, label, cleanup = false) {
    let timer;
    let abort;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(label + ' timed out')), 40000);
          abort = () => reject(new Error(label + ' interrupted'));
          if (!cleanup) {
            cancellation.signal.addEventListener('abort', abort, { once: true });
            if (cancellation.signal.aborted) {
              abort();
            }
          }
        }),
      ]);
    } finally {
      clearTimeout(timer);
      if (abort) {
        cancellation.signal.removeEventListener('abort', abort);
      }
    }
  }
  function adb(argv, binary = false) {
    const result = spawnSync('adb', ['-s', args.serial, ...argv], {
      encoding: binary ? undefined : 'utf8',
      windowsHide: true,
      timeout: 60000,
      maxBuffer: 24 * 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
      throw new Error(
        'adb ' + argv[0] + ': ' + (result.error?.message ?? result.stderr ?? result.stdout)
      );
    }
    return binary ? result.stdout : result.stdout.trim();
  }
  function verifyPid(value) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error('Main process PID missing');
    }
    const candidates = adb(['shell', 'pidof', packageName]).split(/\s+/);
    const command = adb(['exec-out', 'cat', '/proc/' + value + '/cmdline'], true)
      .toString()
      .split('\0')[0];
    if (!candidates.includes(String(value)) || command !== packageName) {
      throw new Error('Original main process is no longer running');
    }
  }
  async function coldStart() {
    adb(['shell', 'am', 'force-stop', packageName]);
    startedApp = true;
    adb(['shell', 'am', 'start', '-n', packageName + '/android.app.NativeActivity']);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (cancellation.signal.aborted) {
        throw new Error('Startup interrupted');
      }
      const activity = adb(['shell', 'dumpsys', 'activity', 'activities']);
      if (mainActivityReady(activity)) {
        try {
          const response = await fetch('http://127.0.0.1:' + httpPort + '/health', {
            signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(2000)]),
          });
          if (response.ok) {
            return;
          }
        } catch {
          /* GET readiness can be repeated; scans are never replayed. */
        }
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    throw new Error('SDK NativeActivity handoff / capability HTTP did not become ready');
  }
  async function collect(name, policy) {
    log('phase ' + name);
    const phase = { policy, pid };
    run.phases[name] = phase;
    const phaseDirectory = path.join(output, name);
    fs.mkdirSync(phaseDirectory);
    if (policy) {
      verifyPid(pid);
      phase.configuration = await bounded(script.exports.configure(policy), 'configure ' + name);
      await bounded(script.exports.drain(), 'discard configuration traffic');
      phase.controls = await bounded(script.exports.casecontrols(), 'controls ' + name);
      phase.controlObservations = await bounded(
        script.exports.drain(),
        'collect control observations'
      );
      writeJson(name + '/controls.json', { result: phase.controls, ...phase.controlObservations });
    }
    const response = await fetch(
      'http://127.0.0.1:' + httpPort + '/events/' + eventCode + ':call',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ detectorIds: ['system_properties'] }),
        signal: AbortSignal.any([cancellation.signal, AbortSignal.timeout(300000)]),
      }
    );
    const raw = await response.text();
    fs.writeFileSync(path.join(phaseDirectory, 'http-response.json'), raw);
    if (!response.ok) {
      throw new Error(name + ' scan HTTP failed: ' + response.status + ' ' + raw);
    }
    phase.response = JSON.parse(raw);
    const scan = phase.response.result;
    if (scan) {
      writeJson(name + '/report.json', scan);
      if (typeof scan.reportText === 'string') {
        fs.writeFileSync(path.join(phaseDirectory, 'report.txt'), scan.reportText, 'utf8');
      }
    }
    verifyPid(scan?.pid);
    if (pid !== undefined && scan.pid !== pid) {
      throw new Error('Main process replaced during ' + name);
    }
    phase.pid = scan.pid;
    if (policy) {
      Object.assign(phase, await bounded(script.exports.drain(), 'Duck API observations ' + name));
      writeJson(name + '/api-observations.json', {
        records: phase.records,
        dropped: phase.dropped,
      });
    }
    log(name + ' original result', {
      scanId: scan.scanId,
      pid: scan.pid,
      status: scan.results?.[0]?.status,
      verdict: scan.results?.[0]?.report?.verdict,
    });
    return scan;
  }
  async function clean(action, operation) {
    try {
      await operation();
      run.cleanup.actions.push({ action, passed: true });
      return true;
    } catch (error) {
      run.cleanup.actions.push({ action, passed: false, error: String(error) });
      run.errors.push(action + ': ' + error);
      return false;
    }
  }
  async function closeScript() {
    let safe = true;
    if (script) {
      safe = await clean('api.dispose', async () => {
        const result = await bounded(script.exports.dispose(), 'dispose', true);
        if (result?.restored !== true) {
          throw new Error('API disposal did not confirm restoration');
        }
      });
      if (!safe) {
        await clean('stop-owned-process-before-unsafe-unload', () =>
          adb(['shell', 'am', 'force-stop', packageName])
        );
      }
      safe = (await clean('script.unload', () => bounded(script.unload(), 'unload', true))) && safe;
      script = null;
    }
    if (session) {
      expectedDetach = true;
      safe =
        (await clean('session.detach', () => bounded(session.detach(), 'detach', true))) && safe;
      session = null;
    }
    return safe;
  }
  try {
    const input = preflight(args);
    run.environment.apkSha256 = input.apkSha256;
    if (input.agent) {
      run.productionManifest = input.agent.manifest;
      writeJson('production-manifest.json', input.agent.manifest);
    } else {
      const built = spawnSync(
        process.execPath,
        [path.join(workspace, 'scripts/build-api-agent.mjs')],
        { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 120000 }
      );
      if (built.error || built.status !== 0) {
        throw new Error('Local API build failed: ' + (built.error?.message ?? built.stderr));
      }
    }
    const apiSource =
      input.agent?.source ?? fs.readFileSync(path.join(workspace, 'dist/android-api.js'), 'utf8');
    const probe = await build({
      entryPoints: [path.join(directory, 'probe.ts')],
      bundle: true,
      write: false,
      format: 'iife',
      platform: 'neutral',
      target: 'es2020',
      tsconfig: path.join(workspace, 'tsconfig.agent.json'),
      plugins: [
        {
          name: 'share-public-bridge',
          setup(builder) {
            builder.onResolve({ filter: /runtime\/java-bridge$/ }, () => ({
              path: 'shared-bridge',
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
    const source = apiSource + '\n' + probe.outputFiles[0].text;
    run.apiAgentSha256 = sha256(apiSource);
    run.scriptSha256 = sha256(source);
    fs.writeFileSync(path.join(output, 'android-api.js'), apiSource);
    fs.writeFileSync(path.join(output, 'injected.js'), source);
    writeJson('policies.json', { observe, risk, normal });
    const api = adb(['shell', 'getprop', 'ro.build.version.sdk']);
    const abi = adb(['shell', 'getprop', 'ro.product.cpu.abi']);
    const client = JSON.parse(
      fs.readFileSync(path.join(workspace, 'node_modules/frida/package.json'), 'utf8')
    ).version;
    if (api !== '33' || abi !== 'x86_64' || client !== lock.fridaVersion) {
      throw new Error('Expected API33 x86_64 and locked Frida ' + lock.fridaVersion);
    }
    const serverPid = adb(['shell', 'pidof', 'agentforge-frida-server']);
    if (!/^\d+$/.test(serverPid)) {
      throw new Error('Expected one running locked agentforge-frida-server');
    }
    const serverExe = '/proc/' + serverPid + '/exe';
    const version = adb(['shell', serverExe, '--version']);
    const hash = adb(['shell', 'sha256sum', serverExe]).split(/\s+/)[0];
    if (version !== lock.fridaVersion || hash !== lock.targets.x86_64.serverSha256) {
      throw new Error('Running Frida server differs from lock');
    }
    Object.assign(run.environment, {
      api: 33,
      abi,
      frida: client,
      serverVersion: version,
      serverSha256: hash,
      node: process.version,
    });
    log('install', adb(['install', '-r', args.apk]));
    const installed = adb(['shell', 'pm', 'path', packageName]).split(/\r?\n/);
    if (installed.length !== 1 || !installed[0].startsWith('package:')) {
      throw new Error('Expected one installed base APK');
    }
    const installedHash = adb(['shell', 'sha256sum', installed[0].slice(8)]).split(/\s+/)[0];
    if (installedHash !== input.apkSha256) {
      throw new Error('Installed APK differs from input');
    }
    run.environment.installedSha256 = installedHash;
    for (const [kind, target] of [
      ['http', '5566'],
      ['frida', '27042'],
    ]) {
      const port = adb(['forward', 'tcp:0', 'tcp:' + target]);
      if (!/^\d+$/.test(port)) {
        throw new Error('Could not allocate own ' + kind + ' forward');
      }
      if (kind === 'http') {
        httpPort = port;
      } else {
        fridaPort = port;
      }
    }
    adb(['shell', 'input', 'keyevent', 'KEYCODE_WAKEUP']);
    adb(['shell', 'wm', 'dismiss-keyguard']);
    await coldStart();
    const baseline = await collect('baseline');
    readSnapshot(run.phases.baseline.response);
    pid = baseline.pid;
    manager = frida.getDeviceManager();
    device = await bounded(manager.addRemoteDevice('127.0.0.1:' + fridaPort), 'connect Frida');
    session = await bounded(device.attach(pid), 'attach main process');
    session.detached.connect(reason => {
      if (!expectedDetach) {
        run.errors.push('Unexpected detach: ' + reason);
        log('unexpected detach', reason);
      }
    });
    script = await bounded(
      session.createScript(source, { name: 'duck-system-properties' }),
      'create script'
    );
    script.message.connect(message => {
      if (message.type === 'error') {
        run.errors.push(message.stack ?? message.description);
        log('agent error', message);
      } else if (message.payload?.type === 'trace-event') {
        fs.appendFileSync(
          path.join(output, 'events.jsonl'),
          JSON.stringify(message.payload.event) + '\n'
        );
      }
    });
    script.logHandler = (level, message) => log('agent/' + level, message);
    await bounded(script.load(), 'load script');
    const identity = await bounded(script.exports.caseinfo(), 'target identity');
    if (
      identity.package !== packageName ||
      identity.pid !== pid ||
      identity.api !== 33 ||
      identity.arch !== 'x64'
    ) {
      throw new Error('Wrong Frida target identity: ' + JSON.stringify(identity));
    }
    run.environment.target = identity;
    for (const [name, policy] of [
      ['observe', observe],
      ['risk', risk],
      ['normal', normal],
      ['restored', observe],
    ]) {
      await collect(name, policy);
    }
    if (!(await closeScript())) {
      throw new Error('Unsafe API disposal; post-unload proof unavailable');
    }
    for (const name of ['after-unload-1', 'after-unload-2']) {
      await collect(name);
    }
    await coldStart();
    pid = undefined;
    await collect('cold');
    completed = true;
  } catch (error) {
    run.errors.push(error.stack ?? String(error));
    log('failed', error.stack ?? String(error));
  } finally {
    await closeScript();
    if (!completed && startedApp) {
      await clean('stop-failed-owned-app', () => adb(['shell', 'am', 'force-stop', packageName]));
    }
    if (manager && device) {
      await clean('remove-frida-remote', () =>
        bounded(manager.removeRemoteDevice('127.0.0.1:' + fridaPort), 'remove remote', true)
      );
    }
    for (const port of [fridaPort, httpPort]) {
      if (port) {
        await clean('remove-own-forward-' + port, () =>
          adb(['forward', '--remove', 'tcp:' + port])
        );
      }
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    run.cleanup.complete = run.cleanup.actions.every(action => action.passed);
    run.finishedAt = new Date().toISOString();
    run.evaluation = evaluateRun(run);
    writeJson('result.json', run);
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
