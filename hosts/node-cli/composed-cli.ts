import fs from 'node:fs';
import path from 'node:path';
import { InputError, parseComposition, resolvePlan, listCapabilities } from './composition';
import { buildComposition } from './composed-build';
import { createSession } from './composed-session';

export async function openComposition(argv: string[], workspace: string) {
  const workingDirectory = process.env.INIT_CWD || process.cwd();
  const options = parseComposition(argv, workingDirectory);
  const plan = resolvePlan(options, workspace);
  const built = await buildComposition(plan, workspace);
  let output = options.output;
  if (output) {
    fs.mkdirSync(path.dirname(output), { recursive: true });
    try {
      fs.mkdirSync(output);
    } catch (error) {
      throw new InputError('Output must be a new directory: ' + error);
    }
  } else {
    const root = path.join(workingDirectory, '.runtime/frida/runs');
    fs.mkdirSync(root, { recursive: true });
    output = fs.mkdtempSync(path.join(root, new Date().toISOString().replace(/[:.]/g, '-') + '-'));
  }
  const write = (file: string, value: unknown) =>
    fs.writeFileSync(path.join(output!, file), JSON.stringify(value, null, 2) + '\n');
  write('plan.json', plan);
  if (built.manifest) {
    write('production-manifest.json', built.manifest);
  }
  fs.writeFileSync(path.join(output, 'android-api.js'), built.source);
  fs.writeFileSync(path.join(output, 'extensions.js'), built.extensions);
  fs.writeFileSync(path.join(output, 'injected.js'), built.full);
  fs.writeFileSync(path.join(output, 'events.jsonl'), '');
  const session = createSession(plan, output, built.full);
  session.log('run plan', {
    workingDirectory,
    output,
    capabilities: plan.extensions.map(item => ({ id: item.id, modes: item.selected })),
    groups: plan.groups,
    traceGroups: plan.traceGroups,
  });
  const result: any = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    agentSource: built.agentSource,
    apiAgentSha256: built.apiAgentSha256,
    extensionsSha256: built.extensionsSha256,
    scriptSha256: built.scriptSha256,
    modules: built.modules,
    inputs: built.inputs,
    plannedGroups: plan.groups,
    traceGroups: plan.traceGroups,
    ruleSources: plan.ruleSources,
    serial: options.serial,
    workingDirectory,
  };
  async function finish() {
    Object.assign(result, await session.close(), { finishedAt: new Date().toISOString() });
    result.status =
      result.errors.length || !result.ready || !result.cleanup.complete ? 'failed' : 'passed';
    write('result.json', result);
    console.log('Results: ' + output);
    return result.status === 'passed' ? 0 : 1;
  }
  return { plan, built, output, session, result, write, finish };
}

export async function compositionCli(argv: string[], workspace: string): Promise<number> {
  if (argv.includes('--help')) {
    console.log(
      'af-frida list | plan | run\n--trace <ids> --replace <ids> --profile <json> --extension <manifest> --script <managed.ts>\nrun requires --serial and one of --spawn <package>, --attach <package|pid>, --app <manifest>\n--agent <js> --production-manifest <json> (paired), --output <new-directory>\n--duration-ms <ms>, --timeout-ms <ms> (startup default 60000)'
    );
    return 0;
  }
  let run: Awaited<ReturnType<typeof openComposition>> | undefined;
  let drainTimer: NodeJS.Timeout | undefined;
  let draining: Promise<void> | undefined;
  let stop: (() => void) | undefined;
  let interrupted = false;
  const onSignal = () => {
    interrupted = true;
    if (!run?.session.result.ready) {
      run?.session.cancel();
    }
    stop?.();
  };
  try {
    const options = parseComposition(argv);
    if (options.command === 'list') {
      console.log(JSON.stringify(listCapabilities(workspace), null, 2));
      return 0;
    }
    if (options.command === 'plan') {
      console.log(JSON.stringify(resolvePlan(options, workspace), null, 2));
      return 0;
    }
    run = await openComposition(argv, workspace);
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    await run.session.prepare();
    await run.session.inject();
    if (!interrupted) {
      await new Promise<void>(resolve => {
        stop = resolve;
        drainTimer = setInterval(() => {
          if (draining) {
            return;
          }
          draining = run!.session
            .drain()
            .catch(error => {
              run!.session.result.errors.push(String(error));
              resolve();
            })
            .finally(() => {
              draining = undefined;
            });
        }, 500);
        if (options.durationMs) {
          setTimeout(resolve, options.durationMs).unref();
        }
      });
    }
  } catch (error) {
    if (!run) {
      console.error(String(error));
      return error instanceof InputError ? 2 : 1;
    }
    run.session.result.errors.push(String(error));
    run.session.log('run failed', String(error));
  } finally {
    clearInterval(drainTimer);
    await draining;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
  return run ? run.finish() : 1;
}
