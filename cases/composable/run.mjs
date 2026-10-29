// A device acceptance driver, not another Frida Host. All target preparation,
// injection, App readiness, disposal and owned resources use the new CLI path.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openComposition } from '../../hosts/node-cli/run.js';
import { options } from '../duck-system-properties/run.mjs';
import {
  sdk,
  packageName,
  eventCode,
  observe,
  risk,
  normal,
} from '../duck-system-properties/spec.mjs';
import { evaluateRun, readSnapshot, renderReport } from '../duck-system-properties/result.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(directory, '../..');
const args = options(process.argv.slice(2));
if (args) {
  const argv = [
    'run',
    '--serial',
    args.serial,
    '--app',
    path.join(workspace, 'apps/detect-env-duck/app.json'),
    '--replace',
    'system-properties',
    '--trace',
    'file-io,system-properties',
    '--profile',
    path.join(workspace, 'cases/duck-system-properties/normal.json'),
    '--script',
    path.join(directory, 'controls.ts'),
  ];
  if (args.agent) {
    argv.push('--agent', args.agent, '--production-manifest', args['production-manifest']);
  }
  if (args.output) {
    argv.push('--output', args.output);
  }
  const run = await openComposition(argv, workspace);
  const { session, built, output } = run;
  const proof = {
    schemaVersion: 1,
    agentSource: built.agentSource,
    productionManifest: built.manifest,
    apiAgentSha256: built.apiAgentSha256,
    scriptSha256: built.scriptSha256,
    sdk: { tag: sdk.tag, commit: sdk.commit, aarSha256: sdk.sha256 },
    environment: { serial: args.serial },
    phases: {},
    errors: [],
    cleanup: { complete: false },
  };
  const interrupt = () => session.cancel();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  const collect = async (name, policy) => {
    const target = session.target;
    const phase = { policy, pid: target.pid };
    proof.phases[name] = phase;
    fs.mkdirSync(path.join(output, name));
    if (policy) {
      phase.configuration = await session.exports.configure(policy);
      await session.exports.drain();
      phase.controls = await session.exports.casecontrols();
      phase.controlObservations = await session.exports.drain();
      run.write(name + '/controls.json', { result: phase.controls, ...phase.controlObservations });
    }
    const response = await fetch(session.ctx.httpBase + '/events/' + eventCode + ':call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ detectorIds: ['system_properties'] }),
      signal: AbortSignal.any([session.ctx.signal, AbortSignal.timeout(300000)]),
    });
    const text = await response.text();
    fs.writeFileSync(path.join(output, name, 'http-response.json'), text);
    if (!response.ok) {
      throw new Error(name + ': scan failed: ' + response.status);
    }
    phase.response = JSON.parse(text);
    const snapshot = readSnapshot(phase.response);
    if (snapshot.scan.pid !== target.pid) {
      throw new Error('Scan ran outside prepared main PID');
    }
    session.verifyPid();
    run.write(name + '/report.json', snapshot.scan);
    fs.writeFileSync(path.join(output, name, 'report.txt'), snapshot.scan.reportText);
    if (policy) {
      Object.assign(phase, await session.exports.drain());
      run.write(name + '/api-observations.json', {
        records: phase.records,
        dropped: phase.dropped,
      });
    }
    session.log('original Duck scan', {
      phase: name,
      scanId: snapshot.scan.scanId,
      critical: snapshot.critical,
      review: snapshot.review,
      status: snapshot.status,
    });
  };
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(workspace, 'test/api33/toolchain.lock.json'))
    );
    const environment = session.environment();
    const client = JSON.parse(
      fs.readFileSync(path.join(workspace, 'node_modules/frida/package.json'))
    ).version;
    if (
      environment.api !== 33 ||
      environment.abi !== 'x86_64' ||
      environment.serverVersion !== lock.fridaVersion ||
      environment.serverSha256 !== lock.targets.x86_64.serverSha256 ||
      client !== lock.fridaVersion
    ) {
      throw new Error('Expected locked API33 x86_64 / Frida toolchain');
    }
    Object.assign(proof.environment, environment, { frida: client }, session.installApk(args.apk));
    await session.prepare();
    await collect('baseline');
    await session.inject();
    proof.environment.target = await session.exports.caseinfo();
    if (proof.environment.target.package !== packageName) {
      throw new Error('Unexpected target');
    }
    for (const [name, policy] of [
      ['observe', observe],
      ['risk', risk],
      ['normal', normal],
      ['restored', observe],
    ]) {
      await collect(name, policy);
    }
    if (!(await session.unload())) {
      throw new Error('Unsafe disposal; post-unload proof unavailable');
    }
    await collect('after-unload-1');
    await collect('after-unload-2');
    await session.coldStart();
    await collect('cold');
  } catch (error) {
    proof.errors.push(error.stack ?? String(error));
    session.result.errors.push(String(error));
  } finally {
    await run.finish();
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    proof.errors.push(...session.result.errors);
    proof.cleanup = session.result.cleanup;
    proof.evaluation = evaluateRun(proof);
    run.write('acceptance-result.json', proof);
    fs.writeFileSync(path.join(output, 'report.md'), renderReport(proof));
    console.log(proof.evaluation.passed ? 'PASS' : 'FAIL', proof.evaluation.failures);
    process.exitCode = proof.evaluation.passed ? 0 : 1;
  }
}
