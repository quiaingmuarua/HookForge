// Exercise npm's actual linked executable. No Frida import, session or direct RPC.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sample, checks } from '../rootbeer/catalog.mjs';
import { readCompletedRootBeerUi, readUiAttribute } from '../rootbeer/ui-xml.mjs';
import {
  readSnapshot,
  javaCaller,
  nativeCaller,
  parseGetprop,
} from '../duck-system-properties/result.mjs';
import { risk, normal, keys, packageName, eventCode } from '../duck-system-properties/spec.mjs';

const workspace = fileURLToPath(new URL('../..', import.meta.url));
const cwd = process.env.INIT_CWD || process.cwd();
const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i];
  assert(
    ['--serial', '--rootbeer-apk', '--duck-apk', '--output'].includes(flag) &&
      process.argv[i + 1] &&
      !args[flag.slice(2)],
    'Invalid or duplicate argument: ' + flag
  );
  args[flag.slice(2)] = process.argv[i + 1];
}
assert(
  args.serial && args['rootbeer-apk'] && args['duck-apk'],
  'linked.mjs --serial <serial> --rootbeer-apk <apk> --duck-apk <apk> [--output <new-directory>]'
);
const output = args.output
  ? path.resolve(cwd, args.output)
  : path.join(
      cwd,
      '.runtime/frida/cases/local-link',
      new Date().toISOString().replace(/[:.]/g, '-')
    );
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.mkdirSync(output);
const write = (file, value) =>
  fs.writeFileSync(path.join(output, file), JSON.stringify(value, null, 2) + '\n');
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const proof = { phases: {}, samples: {}, errors: [], cleanup: { complete: false }, cwd };
const forwards = [];
const children = [];
const scanIds = new Set();
const publicAgent = path.join(workspace, 'dist/android-api.js');
const publicBefore = { sha256: hash(publicAgent), mtimeMs: fs.statSync(publicAgent).mtimeMs };
const adb = (argv, binary = false) => {
  const value = spawnSync('adb', ['-s', args.serial, ...argv], {
    encoding: binary ? undefined : 'utf8',
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 24 * 1024 * 1024,
  });
  assert.equal(value.status, 0, String(value.error || value.stderr));
  return binary ? value.stdout : value.stdout.trim();
};
const pid = name => Number(adb(['shell', 'pidof', name]));
const forward = port => {
  const value = adb(['forward', 'tcp:0', 'tcp:' + port]);
  assert(/^\d+$/.test(value));
  forwards.push(value);
  return 'http://127.0.0.1:' + value;
};
function events(toolOutput) {
  if (!toolOutput || !fs.existsSync(path.join(toolOutput, 'events.jsonl'))) {
    return [];
  }
  const text = fs.readFileSync(path.join(toolOutput, 'events.jsonl'), 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}
async function startCli(name, argv, defaultOutput = false) {
  const directory = path.join(output, name);
  fs.mkdirSync(directory);
  const full = ['run', '--serial', args.serial, ...argv, '--duration-ms', '22000'];
  if (!defaultOutput) {
    full.push('--output', path.join(directory, 'tool'));
  }
  write(name + '/command.json', { command: 'af-frida', argv: full, cwd });
  const child =
    process.platform === 'win32'
      ? spawn(
          'C:/Program Files/Git/bin/bash.exe',
          ['-lc', 'exec af-frida "$@"', 'af-frida', ...full],
          { cwd, windowsHide: true, env: { ...process.env, INIT_CWD: cwd } }
        )
      : spawn('af-frida', full, { cwd, env: { ...process.env, INIT_CWD: cwd } });
  let stdout = '';
  let code;
  child.stdout.on('data', bytes => {
    stdout += bytes;
    fs.appendFileSync(path.join(directory, 'stdout.log'), bytes);
  });
  child.stderr.on('data', bytes => fs.appendFileSync(path.join(directory, 'stderr.log'), bytes));
  const ended = new Promise(resolve => {
    child.on('close', value => {
      code = value ?? 1;
      resolve(code);
    });
    child.on('error', error => {
      code = 1;
      proof.errors.push(String(error));
      resolve(code);
    });
  });
  const running = { child, ended, directory };
  children.push(running);
  const deadline = Date.now() + 70000;
  while (Date.now() < deadline) {
    assert.equal(code, undefined, name + ': CLI exited before readiness: ' + stdout);
    const location = stdout.match(/run plan (\{[^\r\n]+\})/)?.[1];
    if (location) {
      running.toolOutput = JSON.parse(location).output;
      const ready = events(running.toolOutput).find(item => item.type === 'ready');
      if (ready) {
        running.ready = ready;
        assert.equal(ready.target.pid, pid(ready.target.package));
        console.log(name + ' ready PID ' + ready.target.pid);
        return running;
      }
    }
    await delay(100);
  }
  throw new Error(name + ': linked CLI did not become ready');
}
async function stopped(running) {
  let timer;
  let code;
  try {
    code = await Promise.race([
      running.ended,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('CLI stop timed out')), 85000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
  assert.equal(code, 0, 'CLI failed: ' + running.directory);
  const result = JSON.parse(fs.readFileSync(path.join(running.toolOutput, 'result.json')));
  assert.equal(result.status, 'passed');
  assert.equal(result.cleanup.complete, true);
  assert.equal(result.apiAgentSha256, publicBefore.sha256);
  return { ...result, output: running.toolOutput };
}
const records = running => {
  const batches = events(running.toolOutput).filter(item =>
    ['api-observations', 'final-observations', 'startup-observations'].includes(item.type)
  );
  assert(batches.length && batches.every(batch => batch.dropped === 0));
  const values = batches.flatMap(batch => batch.records);
  assert(values.every(item => !item.error && !item.runtimeError));
  return values;
};
async function rootUi(name) {
  const remote = '/data/local/tmp/hookforge-link-' + process.pid + '.xml';
  const dump = () => {
    try {
      adb(['shell', 'uiautomator', 'dump', remote]);
      return adb(['shell', 'cat', remote]);
    } finally {
      adb(['shell', 'rm', '-f', remote]);
    }
  };
  const deadline = Date.now() + 30000;
  let xml;
  let button;
  while (Date.now() < deadline && !button) {
    xml = dump();
    button = xml
      .match(/<node\b[^>]*>/g)
      ?.find(node => readUiAttribute(node, 'resource-id') === sample.package + ':id/fab');
    if (!button) {
      await delay(200);
    }
  }
  assert(button, 'RootBeer repeat control missing');
  const bounds = readUiAttribute(button, 'bounds').match(/\d+/g).map(Number);
  adb([
    'shell',
    'input',
    'tap',
    String((bounds[0] + bounds[2]) >> 1),
    String((bounds[1] + bounds[3]) >> 1),
  ]);
  await delay(8000);
  while (Date.now() < deadline) {
    xml = dump();
    const text = readCompletedRootBeerUi(xml, checks.length);
    if (text) {
      fs.writeFileSync(path.join(output, name + '.xml'), xml);
      fs.writeFileSync(
        path.join(output, name + '.png'),
        adb(['exec-out', 'screencap', '-p'], true)
      );
      return { pid: pid(sample.package), text };
    }
    await delay(200);
  }
  throw new Error('RootBeer original UI did not finish');
}
async function scan(name, base) {
  const response = await fetch(base + '/events/' + eventCode + ':call', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ detectorIds: ['system_properties'] }),
    signal: AbortSignal.timeout(120000),
  });
  const body = await response.json();
  write(name + '-http.json', body);
  assert(response.ok);
  const snapshot = readSnapshot(body);
  assert(!scanIds.has(snapshot.scan.scanId), 'Scan ID reused');
  scanIds.add(snapshot.scan.scanId);
  assert.equal(snapshot.scan.pid, pid(packageName));
  write(name + '-report.json', snapshot.scan);
  fs.writeFileSync(path.join(output, name + '-report.txt'), snapshot.scan.reportText);
  console.log(name + ' Critical=' + snapshot.critical + ' PID=' + snapshot.scan.pid);
  proof.phases[name] = {
    pid: snapshot.scan.pid,
    scanId: snapshot.scan.scanId,
    properties: snapshot.properties,
    critical: snapshot.critical,
    status: snapshot.status,
  };
  return snapshot;
}
function verifySdk(snapshot, api, policy) {
  const expected = policy?.rules.properties ?? snapshot.properties;
  assert.deepEqual(snapshot.properties, expected);
  const commands = api.filter(
    item =>
      item.api === 'ProcessBuilder.start' &&
      javaCaller(item) &&
      item.args.argv.length === 1 &&
      ['getprop', '/system/bin/getprop'].includes(item.args.argv[0])
  );
  assert.equal(commands.length, 1);
  if (policy) {
    assert.equal(commands[0].result.exitCode, 0);
    assert.equal(commands[0].original.exitCode, 0);
    const strip = text =>
      text
        .split('\n')
        .filter(line => !keys.some(key => line.startsWith('[' + key + ']: ')))
        .join('\n');
    assert.equal(strip(commands[0].result.stdout), strip(commands[0].original.stdout));
  } else {
    assert.equal(commands[0].result, 'real-process');
  }
  for (const key of keys) {
    const java = api.filter(
      item =>
        /^SystemProperties.get\([12]\)$/.test(item.api) && item.args.key === key && javaCaller(item)
    );
    const native = api.filter(
      item =>
        item.api === 'libc.__system_property_read_callback' &&
        item.args.key === key &&
        nativeCaller(item)
    );
    assert(java.length && native.length, key + ': actual SDK callers absent');
    assert(
      api.some(
        item =>
          item.api === 'libc.__system_property_find' &&
          item.args.key === key &&
          nativeCaller(item) &&
          item.result.found
      )
    );
    assert([...java, ...native].every(item => item.result === expected[key]));
    if (policy) {
      assert.equal(parseGetprop(commands[0].result.stdout).get(key), expected[key]);
    }
  }
}

try {
  const lock = JSON.parse(fs.readFileSync(path.join(workspace, 'test/api33/toolchain.lock.json')));
  assert.equal(adb(['shell', 'getprop', 'ro.build.version.sdk']), '33');
  assert.equal(adb(['shell', 'getprop', 'ro.product.cpu.abi']), 'x86_64');
  const server = '/proc/' + adb(['shell', 'pidof', 'agentforge-frida-server']) + '/exe';
  assert.equal(adb(['shell', server, '--version']), lock.fridaVersion);
  assert.equal(
    adb(['shell', 'sha256sum', server]).split(/\s+/)[0],
    lock.targets.x86_64.serverSha256
  );
  for (const [name, apk, packageId] of [
    ['rootbeer', args['rootbeer-apk'], sample.package],
    ['duck', args['duck-apk'], packageName],
  ]) {
    const file = path.resolve(cwd, apk);
    const sha256 = hash(file);
    if (name === 'rootbeer') {
      assert.equal(sha256, sample.sha256);
    }
    adb(['install', '-r', '-t', file]);
    const installed = adb(['shell', 'pm', 'path', packageId]).replace(/^package:/, '');
    assert.equal(adb(['shell', 'sha256sum', installed]).split(/\s+/)[0], sha256);
    proof.samples[name] = { apk: file, sha256, package: packageId };
  }
  adb(['shell', 'am', 'force-stop', sample.package]);
  adb(['shell', 'am', 'start', '-n', sample.package + '/.MainActivity']);
  const baseline = await rootUi('rootbeer-baseline');
  proof.phases.rootbeerBaseline = baseline;
  for (const mode of ['observe', 'root']) {
    const cli = await startCli(
      'rootbeer-' + mode,
      [
        '--spawn',
        sample.package,
        '--trace',
        'file-io,system-properties',
        ...(mode === 'root' ? ['--replace', 'root'] : []),
        '--script',
        path.join(workspace, 'cases/composable/linked-rootbeer.ts'),
      ],
      mode === 'observe'
    );
    const ui = await rootUi('rootbeer-' + mode);
    const result = await stopped(cli);
    const raw = events(cli.toolOutput)
      .filter(item => item.payload?.type === 'rootbeer-results')
      .at(-1)?.payload.data.value;
    assert(raw && raw.pid === ui.pid && raw.checks.length === checks.length);
    assert.equal(raw.rooted, mode === 'observe');
    assert.equal(
      raw.rooted,
      raw.checks.some(item => item.value)
    );
    if (mode === 'observe') {
      assert.equal(ui.text, baseline.text);
    } else {
      assert.notEqual(ui.text, baseline.text);
      assert(raw.checks.every(item => item.value === false));
    }
    const api = records(cli);
    const actual = api.filter(item =>
      item.caller?.stack?.some(line => line.includes('com.scottyab.rootbeer.RootBeer.'))
    );
    assert(actual.some(item => item.api === 'java.io.File.exists'));
    assert(actual.some(item => item.args?.argv?.[0] === 'getprop'));
    assert(
      mode === 'observe' ? api.every(item => !item.changed) : actual.some(item => item.changed)
    );
    proof.phases['rootbeer-' + mode] = { ...ui, ...raw, tool: result };
    const restored = await rootUi('rootbeer-' + mode + '-restored');
    assert.equal(restored.pid, ui.pid);
    assert.equal(restored.text, baseline.text);
    proof.phases['rootbeer-' + mode + '-restored'] = restored;
  }
  adb(['shell', 'am', 'force-stop', sample.package]);
  adb(['shell', 'am', 'start', '-n', sample.package + '/.MainActivity']);
  proof.phases.rootbeerCold = await rootUi('rootbeer-cold');
  assert.equal(proof.phases.rootbeerCold.text, baseline.text);
  assert.notEqual(proof.phases.rootbeerCold.pid, proof.phases['rootbeer-root'].pid);

  // A caller-owned App, profile, extension and script: none require package edits.
  const project = path.join(output, 'external project');
  fs.mkdirSync(project);
  fs.copyFileSync(
    path.join(workspace, 'apps/detect-env-duck/host.mjs'),
    path.join(project, 'host.mjs')
  );
  fs.writeFileSync(
    path.join(project, 'agent.ts'),
    'export function activate(ctx) { ctx.emit("external-active", { pid: Process.id }); return () => ctx.emit("external-stopped"); }'
  );
  fs.writeFileSync(
    path.join(project, 'script.ts'),
    'export function activate(ctx) { ctx.emit("external-script-active", { pid: Process.id }); return () => ctx.emit("external-script-stopped"); }'
  );
  fs.writeFileSync(
    path.join(project, 'unused.ts'),
    'throw new Error("UNSELECTED_EXTENSION_EXECUTED");'
  );
  const local = (file, value) =>
    fs.writeFileSync(path.join(project, file), JSON.stringify(value, null, 2));
  local('app.json', {
    id: 'external-duck',
    package: packageName,
    process: packageName,
    launch: { mode: 'activity', activity: 'android.app.NativeActivity' },
    host: 'host.mjs',
    agent: 'agent.ts',
  });
  local('extension.json', { id: 'external-proof', modes: ['trace'], entry: 'agent.ts' });
  local('unused.json', { id: 'unused', modes: ['trace'], entry: 'unused.ts' });
  local('risk.json', risk);
  local('normal.json', normal);
  const base = forward(5566);
  // Original startup and readiness are exactly the existing App Host, without a Script.
  const { waitReady } = await import('../../apps/detect-env-duck/host.mjs');
  const originalDuck = async () => {
    adb(['shell', 'am', 'force-stop', packageName]);
    adb(['shell', 'am', 'start', '-n', packageName + '/android.app.NativeActivity']);
    const deadline = Date.now() + 60000;
    await waitReady(
      {
        httpBase: base,
        adb,
        signal: new AbortController().signal,
        remainingMs: () => deadline - Date.now(),
      },
      { package: packageName }
    );
    return pid(packageName);
  };
  await originalDuck();
  const duckBaseline = await scan('duck-baseline', base);
  const snapshots = {};
  for (const mode of ['observe', 'risk', 'normal']) {
    const cli = await startCli('duck-' + mode, [
      '--app',
      path.join(project, 'app.json'),
      '--trace',
      'system-properties,external-proof',
      '--extension',
      path.join(project, 'extension.json'),
      '--extension',
      path.join(project, 'unused.json'),
      '--script',
      path.join(project, 'script.ts'),
      ...(mode === 'observe'
        ? []
        : ['--replace', 'system-properties', '--profile', path.join(project, mode + '.json')]),
    ]);
    snapshots[mode] = await scan('duck-' + mode, base);
    const result = await stopped(cli);
    const api = records(cli);
    verifySdk(
      snapshots[mode],
      api,
      mode === 'risk' ? risk : mode === 'normal' ? normal : undefined
    );
    assert.deepEqual(snapshots[mode].unrelated, duckBaseline.unrelated);
    for (const source of Object.keys(duckBaseline.coverage)) {
      assert(snapshots[mode].coverage[source] >= duckBaseline.coverage[source]);
    }
    if (mode === 'observe') {
      assert.deepEqual(snapshots[mode].stable, duckBaseline.stable);
      assert(api.every(item => !item.changed));
    }
    assert(events(cli.toolOutput).some(item => item.payload?.type === 'external-active'));
    assert(events(cli.toolOutput).some(item => item.payload?.type === 'external-script-active'));
    assert(
      !fs
        .readFileSync(path.join(cli.toolOutput, 'extensions.js'), 'utf8')
        .includes('UNSELECTED_EXTENSION_EXECUTED')
    );
    proof.phases['duck-' + mode].tool = result;
    for (let i = 1; i <= 2; i++) {
      const restored = await scan('duck-' + mode + '-after-unload-' + i, base);
      assert.equal(restored.scan.pid, snapshots[mode].scan.pid);
      assert.deepEqual(restored.stable, duckBaseline.stable);
    }
  }
  assert(
    snapshots.normal.critical < snapshots.risk.critical,
    'Original SDK risk judgment did not change'
  );
  await originalDuck();
  const cold = await scan('duck-cold', base);
  assert.notEqual(cold.scan.pid, snapshots.normal.scan.pid);
  assert.deepEqual(cold.stable, duckBaseline.stable);
  assert.deepEqual(
    { sha256: hash(publicAgent), mtimeMs: fs.statSync(publicAgent).mtimeMs },
    publicBefore
  );
  proof.publicAgent = publicBefore;
} catch (error) {
  proof.errors.push(error.stack || String(error));
  console.error(error);
} finally {
  for (const child of children) {
    if (child.child.exitCode === null) {
      await child.ended;
    }
  }
  for (const port of forwards.reverse()) {
    try {
      adb(['forward', '--remove', 'tcp:' + port]);
    } catch (error) {
      proof.errors.push(String(error));
    }
  }
  proof.cleanup.complete =
    children.every(child => child.child.exitCode === 0) && proof.errors.length === 0;
  proof.evaluation = {
    passed: proof.errors.length === 0 && proof.cleanup.complete,
    failures: proof.errors,
  };
  write('result.json', proof);
  fs.writeFileSync(
    path.join(output, 'report.md'),
    [
      '# Linked CLI real APK proof',
      '',
      'Result: ' + (proof.evaluation.passed ? 'PASS' : 'FAIL'),
      '',
      '| Phase | PID | Result |',
      '| --- | --- | --- |',
      ...Object.entries(proof.phases).map(
        ([name, value]) =>
          '| ' +
          name +
          ' | ' +
          value.pid +
          ' | ' +
          (value.text ?? 'Critical=' + value.critical) +
          ' |'
      ),
      '',
      ...proof.errors.map(error => '- ' + error),
      '',
    ].join('\n')
  );
  console.log('Results: ' + output);
  process.exitCode = proof.evaluation.passed ? 0 : 1;
}
