import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openComposition, parseComposition, resolvePlan } from '../../hosts/node-cli/run.js';
import { options, preflight } from '../duck-system-properties/run.mjs';
import {
  sdk,
  packageName,
  eventCode,
  detectorIds,
  propertyKeys,
  profilesFromFingerprint,
  observe,
} from './spec.mjs';
import { readBuildSnapshot, evaluateRun, renderReport } from './result.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(directory, '../..');

export async function main(args) {
  // Immutable inputs are checked before constructing a session or touching ADB.
  preflight(args);
  const output =
    args.output ??
    path.join(
      workspace,
      '.runtime/frida/cases/duck-build-profile',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
    );
  const argv = [
    'run',
    '--serial',
    args.serial,
    '--app',
    path.join(workspace, 'apps/detect-env-duck/app.json'),
    '--replace',
    'build-fields,system-properties',
    '--trace',
    'system-properties',
    '--script',
    path.join(directory, 'controls.ts'),
    '--output',
    output,
  ];
  if (args.agent) {
    argv.push('--agent', args.agent, '--production-manifest', args['production-manifest']);
  }
  const run = await openComposition(argv, workspace);
  const { session, built } = run;
  const proof = {
    schemaVersion: 1,
    agentSource: built.agentSource,
    productionManifest: built.manifest,
    apiAgentSha256: built.apiAgentSha256,
    extensionsSha256: built.extensionsSha256,
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
    const phase = { policy, pid: session.target.pid };
    proof.phases[name] = phase;
    fs.mkdirSync(path.join(run.output, name));
    if (policy) {
      phase.configuration = await session.exports.configure(policy);
      await session.exports.drain();
      phase.controls = {
        ...(await session.exports.casecontrols()),
        ...(await session.exports.casefields(propertyKeys)),
      };
      phase.controlObservations = await session.exports.drain();
      run.write(name + '/controls.json', { result: phase.controls, ...phase.controlObservations });
      run.write(name + '/field-receipts.json', phase.configuration);
    }
    const response = await fetch(session.ctx.httpBase + '/events/' + eventCode + ':call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ detectorIds }),
      signal: AbortSignal.any([session.ctx.signal, AbortSignal.timeout(300000)]),
    });
    const text = await response.text();
    fs.writeFileSync(path.join(run.output, name, 'http-response.json'), text);
    if (!response.ok) {
      throw new Error(name + ': HTTP scan failed ' + response.status);
    }
    phase.response = JSON.parse(text);
    run.write(name + '/report.json', phase.response.result);
    if (typeof phase.response.result?.reportText === 'string') {
      fs.writeFileSync(path.join(run.output, name, 'report.txt'), phase.response.result.reportText);
    }
    if (policy) {
      Object.assign(phase, await session.exports.drain());
      run.write(name + '/api-observations.json', {
        records: phase.records,
        dropped: phase.dropped,
      });
    }
    const value = readBuildSnapshot(phase.response);
    if (value.scan.pid !== phase.pid) {
      throw new Error('Scan ran outside the verified main PID');
    }
    session.verifyPid();
    session.log('original Duck scan', {
      phase: name,
      scanId: value.scan.scanId,
      critical: value.critical,
      review: value.review,
      buildFindings: value.virtualBuild.length,
      status: value.status,
    });
    return value;
  };
  try {
    const lock = JSON.parse(
      fs.readFileSync(path.join(workspace, 'test/api33/toolchain.lock.json'), 'utf8')
    );
    const client = JSON.parse(
      fs.readFileSync(path.join(workspace, 'node_modules/frida/package.json'), 'utf8')
    ).version;
    const environment = session.environment();
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
    const baseline = await collect('baseline');
    proof.profiles = profilesFromFingerprint(baseline.reportedFields.FINGERPRINT);
    fs.mkdirSync(path.join(run.output, 'profiles'));
    for (const [name, policy] of Object.entries(proof.profiles)) {
      const file = path.join(run.output, 'profiles', name + '.json');
      run.write('profiles/' + name + '.json', policy);
      const replace =
        name === 'properties-only'
          ? 'system-properties'
          : name === 'fields-only'
            ? 'build-fields'
            : 'build-fields,system-properties';
      const plan = resolvePlan(
        parseComposition([
          'plan',
          '--replace',
          replace,
          '--trace',
          'system-properties',
          '--profile',
          file,
        ]),
        workspace
      );
      run.write('profiles/' + name + '.plan.json', plan);
      proof.profiles[name] = plan.policy;
    }
    await session.inject();
    proof.environment.target = await session.exports.caseinfo();
    if (proof.environment.target.package !== packageName) {
      throw new Error('Unexpected target');
    }
    await collect('observe', observe);
    for (const name of ['properties-only', 'fields-only', 'inconsistent', 'combined']) {
      await collect(name, proof.profiles[name]);
    }
    await collect('restored', observe);
    if (!(await session.unload())) {
      throw new Error('Unsafe disposal; post-unload evidence unavailable');
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
    proof.finalInstallation = session.result.finalInstallation;
    proof.toolStatus = run.result.status;
    proof.evaluation = evaluateRun(proof);
    run.write('acceptance-result.json', proof);
    fs.writeFileSync(path.join(run.output, 'report.md'), renderReport(proof));
    console.log(proof.evaluation.passed ? 'PASS' : 'FAIL', proof.evaluation.failures);
  }
  return proof.evaluation.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = options(process.argv.slice(2), undefined, 'case:duck-build-profile');
    if (args) {
      process.exitCode = await main(args);
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
