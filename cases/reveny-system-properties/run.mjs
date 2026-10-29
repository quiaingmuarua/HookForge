import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openComposition } from '../../hosts/node-cli/run.js';
import { options } from '../duck-system-properties/run.mjs';
import { apkNativeAbis, productionAgent } from '../../scripts/case-artifact.mjs';
import { sample } from './catalog.mjs';
import { snapshot } from '../../apps/reveny-emulator/host.mjs';
import { evaluateRun, renderReport } from './result.mjs';

const directory = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(directory, '../..');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function preflight(args) {
  if (args.output && fs.existsSync(args.output)) {
    throw new Error('Output must be a new directory');
  }
  const bytes = fs.readFileSync(args.apk);
  if (
    hash(bytes) !== sample.sha256 ||
    !apkNativeAbis(bytes, 'libemulatordetector.so').includes('x86_64')
  ) {
    throw new Error('Expected fixed original Reveny v1.5.0 APK');
  }
  return args.agent ? productionAgent(args.agent, args['production-manifest']) : null;
}

export async function main(args) {
  preflight(args);
  const output =
    args.output ??
    path.join(
      workspace,
      '.runtime/frida/cases/reveny-system-properties',
      new Date().toISOString().replace(/[:.]/g, '-') + '-' + randomUUID().slice(0, 8)
    );
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.mkdirSync(output);
  const write = (name, data) =>
    fs.writeFileSync(path.join(output, name), JSON.stringify(data, null, 2) + '\n');
  const proof = {
    schemaVersion: 1,
    agentSource: args.agent ? 'production-artifact' : 'local-build',
    sample,
    phases: {},
    errors: [],
    cleanup: { complete: true },
  };
  let active;
  let cancelled = false;
  const interrupt = () => {
    cancelled = true;
    active?.session.cancel();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    for (const name of ['baseline', 'observe', 'risk', 'normal', 'cold']) {
      if (cancelled) {
        throw new Error('Case cancelled');
      }
      const instrumented = !['baseline', 'cold'].includes(name);
      const stageOutput = path.join(output, name);
      const argv = [
        'run',
        '--serial',
        args.serial,
        '--app',
        path.join(workspace, 'apps/reveny-emulator/app.json'),
        '--trace',
        'system-properties',
        '--output',
        stageOutput,
      ];
      if (instrumented) {
        argv.push('--script', path.join(directory, 'controls.ts'));
      }
      if (['risk', 'normal'].includes(name)) {
        argv.push(
          '--replace',
          'system-properties',
          '--profile',
          path.join(directory, name + '.json')
        );
      }
      if (args.agent) {
        argv.push('--agent', args.agent, '--production-manifest', args['production-manifest']);
      }
      const run = await openComposition(argv, workspace);
      active = run;
      const { session } = run;
      const phase = {
        policy: run.plan.policy,
        apiAgentSha256: run.built.apiAgentSha256,
        scriptSha256: run.built.scriptSha256,
      };
      proof.phases[name] = phase;
      let phaseError;
      try {
        if (name === 'baseline') {
          const lock = JSON.parse(
            fs.readFileSync(path.join(workspace, 'test/api33/toolchain.lock.json'), 'utf8')
          );
          const client = JSON.parse(
            fs.readFileSync(path.join(workspace, 'node_modules/frida/package.json'), 'utf8')
          ).version;
          proof.environment = session.environment();
          if (
            proof.environment.api !== 33 ||
            proof.environment.abi !== 'x86_64' ||
            proof.environment.serverVersion !== lock.fridaVersion ||
            proof.environment.serverSha256 !== lock.targets.x86_64.serverSha256 ||
            client !== lock.fridaVersion
          ) {
            throw new Error('Expected locked API33 x86_64 / Frida toolchain');
          }
          proof.environment.apk = session.installApk(args.apk);
          const installed = session.adb(['shell', 'dumpsys', 'package', sample.package]);
          if (
            !/versionName=1\.5\.0\b/.test(installed) ||
            !/versionCode=150\b/.test(installed) ||
            !/primaryCpuAbi=x86_64\b/.test(installed)
          ) {
            throw new Error('Wrong installed sample identity');
          }
          proof.apiAgentSha256 = run.built.apiAgentSha256;
          proof.productionManifest = run.built.manifest;
        }
        if (instrumented) {
          await session.prepare();
          await session.inject();
          phase.nativeStartup = session.result.nativeStartup;
        } else {
          await session.launchOriginal();
        }
        phase.pid = session.target.pid;
        phase.instrumentation = session.result.instrumentation;
        phase.ui = snapshot(session.ctx, session.target);
        run.write('original-ui.json', phase.ui);
        fs.writeFileSync(path.join(stageOutput, 'original-ui.xml'), phase.ui.xml);
        fs.writeFileSync(path.join(stageOutput, 'original-ui.txt'), phase.ui.text, 'utf8');
        fs.writeFileSync(
          path.join(stageOutput, 'original-ui.png'),
          session.adb(['exec-out', 'screencap', '-p'], true)
        );
        fs.writeFileSync(
          path.join(stageOutput, 'logcat.txt'),
          session.adb(['logcat', '-d', '--pid=' + phase.pid, '-s', 'EmulatorDetection:I', '*:S'])
        );
        if (instrumented) {
          const batch = await session.exports.drain();
          const startup = fs
            .readFileSync(path.join(stageOutput, 'events.jsonl'), 'utf8')
            .split('\n')
            .filter(Boolean)
            .map(line => JSON.parse(line))
            .filter(message => message.type === 'startup-observations');
          phase.records = [...startup.flatMap(item => item.records), ...batch.records];
          phase.dropped = startup.reduce((count, item) => count + item.dropped, batch.dropped);
          run.write('api-observations.json', { records: phase.records, dropped: phase.dropped });
          phase.controls = await session.exports.casecontrols();
          run.write('control-observations.json', await session.exports.drain());
          await session.exports.configure({ mode: 'observe', captureStack: true });
          phase.restoredControls = await session.exports.casecontrols();
          phase.dispose = await session.exports.dispose();
          phase.disposedControls = await session.exports.casecontrols();
          run.write('controls.json', {
            configured: phase.controls,
            restored: phase.restoredControls,
            disposed: phase.disposedControls,
          });
          await session.unload();
          phase.afterUnload = snapshot(session.ctx, session.target);
          run.write('after-unload-ui.json', phase.afterUnload);
          fs.writeFileSync(
            path.join(stageOutput, 'after-unload-ui.png'),
            session.adb(['exec-out', 'screencap', '-p'], true)
          );
        }
      } catch (error) {
        phaseError = error;
        session.result.errors.push(String(error));
      } finally {
        await run.finish();
        phase.toolPassed = run.result.status === 'passed';
        phase.cleanup = run.result.cleanup;
      }
      if (phaseError) {
        throw phaseError;
      }
      if (!phase.toolPassed) {
        throw new Error(name + ': tool lifecycle failed: ' + run.result.errors.join('; '));
      }
      active = undefined;
      write('evidence.json', proof);
    }
  } catch (error) {
    proof.errors.push(String(error));
  } finally {
    if (active) {
      await active.finish();
      proof.cleanup.complete =
        active.result.cleanup.complete &&
        Object.values(proof.phases).every(phase => phase.cleanup?.complete);
    } else {
      proof.cleanup.complete = Object.values(proof.phases).every(phase => phase.cleanup?.complete);
    }
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    proof.evaluation = evaluateRun(proof);
    write('result.json', { ...proof, status: proof.evaluation.passed ? 'passed' : 'failed' });
    write('acceptance-result.json', proof);
    fs.writeFileSync(path.join(output, 'report.md'), renderReport(proof));
  }
  console.log(proof.evaluation.passed ? 'PASS' : 'FAIL', output, proof.evaluation.failures);
  return proof.evaluation.passed ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    const args = options(process.argv.slice(2), undefined, 'case:reveny-system-properties');
    if (args) {
      preflight(args);
      process.exitCode = await main(args);
    }
  } catch (error) {
    console.error(String(error));
    process.exitCode = 2;
  }
}
