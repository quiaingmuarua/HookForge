import frida from 'frida';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { compositionCli } from './composed-cli';
import { offlineCli } from './composition';
import { boundedOperation, attachScript } from './session-utils';
export { openComposition } from './composed-cli';
export { parseComposition, resolvePlan } from './composition';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

function parseArgs(args: string[]) {
  const options = {
    target: '',
    config: path.join(projectRoot, 'configs/targets/default.json'),
    bundle: path.join(projectRoot, 'dist/bundle.js'),
    dumpEvents: false,
    dumpEventsPath: '',
    spawn: false,
    frontmost: false,
    device: 'usb',
    verbose: false,
    smoke: false,
    requiredModules: [] as string[],
    requiredRecipes: [] as string[],
    result: '',
    timeoutMs: 10000,
    durationMs: 0,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '-h':
      case '--help':
        options.help = true;
        break;
      case '-s':
      case '--spawn':
        options.spawn = true;
        break;
      case '-F':
      case '--frontmost':
        options.frontmost = true;
        break;
      case '-v':
      case '--verbose':
        options.verbose = true;
        break;
      case '--smoke':
        options.smoke = true;
        break;
      case '--require-module':
        options.requiredModules.push(args[++i]);
        break;
      case '--require-recipe':
        options.requiredRecipes.push(args[++i]);
        break;
      case '--result':
        options.result = args[++i];
        break;
      case '--dump-events':
        options.dumpEvents = true;
        if (args[i + 1] && !args[i + 1].startsWith('-')) {
          options.dumpEventsPath = args[++i];
        }
        break;
      case '--timeout-ms':
        options.timeoutMs = Number(args[++i]);
        break;
      case '--duration-ms':
        options.durationMs = Number(args[++i]);
        break;
      case '-c':
      case '--config':
        options.config = args[++i];
        break;
      case '-b':
      case '--bundle':
        options.bundle = args[++i];
        break;
      case '-d':
      case '--device':
        options.device = args[++i];
        break;
      default:
        if (!options.target) {
          options.target = arg;
        }
        break;
    }
  }

  return options;
}

function showHelp() {
  console.log(`
Frida Workspace CLI

Usage: node run.js [options] [target]

Arguments:
  target              Target process name, package name, or PID

Options:
  -s, --spawn         Spawn the target process instead of attaching
  -F, --frontmost     Attach to the current frontmost application
  -c, --config FILE   Config file path (default: configs/targets/default.json)
  -b, --bundle FILE   Bundle file path (default: dist/bundle.js)
  -d, --device TYPE   Device type: usb, local, remote:HOST (default: usb)
  -v, --verbose       Enable verbose message logging
  --smoke             Exit automatically after readiness or timeout
  --require-module ID Require activation of this module (repeatable, smoke only)
  --require-recipe ID Require activation of this recipe (repeatable, smoke only)
  --result FILE       Save outcome, messages and cleanup as JSON
  --dump-events [F]   Save trace-event messages as JSONL under .runtime/normalized/
  --timeout-ms N      Timeout used by smoke mode (default: 10000)
  --duration-ms N     Exit cleanly after N ms, preserving dumped events
  -h, --help          Show this help message

Examples:
  node run.js com.example.app
  node run.js -s com.example.app
  node run.js --frontmost
  node run.js --config configs/targets/telegram.json org.telegram.messenger
  node run.js --device local Calculator
  node run.js --smoke -s com.android.settings
  node run.js --dump-events -s com.android.settings
  node run.js --duration-ms 20000 --dump-events -s com.android.settings
`);
}

async function getDevice(deviceType: string): Promise<frida.Device> {
  if (deviceType === 'local') {
    return await frida.getLocalDevice();
  }
  if (deviceType === 'usb') {
    return await frida.getUsbDevice();
  }
  if (deviceType.startsWith('remote:')) {
    const host = deviceType.substring(7);
    const manager = frida.getDeviceManager();
    return await manager.addRemoteDevice(host);
  }

  throw new Error(`Unknown device type: ${deviceType}`);
}

function handleFileSave(payload: any) {
  try {
    const { path: filePath, content, encoding = 'utf8' } = payload;
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    fs.writeFileSync(filePath, content, encoding);
    console.log(`[FILE] Saved: ${filePath}`);
  } catch (error) {
    console.error(`[FILE] Failed to save ${payload.path}: ${error}`);
  }
}

function makeDefaultEventDumpPath(target: string, frontmost: boolean) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const targetName = (frontmost ? 'frontmost' : target || 'unknown')
    .replace(/[^\w.-]+/g, '_')
    .slice(0, 80);
  return path.join(projectRoot, '.runtime', 'normalized', `${targetName}_${timestamp}.jsonl`);
}

function flushEvents(filePath: string, events: any[]) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const lines = events.map(event => JSON.stringify(event)).join('\n');
  fs.writeFileSync(filePath, lines.length > 0 ? `${lines}\n` : '', 'utf8');
  console.log(`[*] Trace events saved: ${filePath}`);
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  connect: (type: string) => Promise<frida.Device> = getDevice
): Promise<number> {
  const options = parseArgs(argv);
  if (options.help) {
    showHelp();
    return 0;
  }

  const traceEvents: any[] = [];
  const dumpEventsPath =
    options.dumpEventsPath || makeDefaultEventDumpPath(options.target, options.frontmost);
  const outcome = {
    schemaVersion: 1,
    startedAt: new Date().toISOString(),
    status: 'failed',
    mode: options.spawn ? 'spawn' : 'attach',
    pid: null as number | null,
    ready: false,
    reason: '',
    modules: {} as Record<string, string>,
    recipes: {} as Record<string, string>,
    messages: [] as unknown[],
    errors: [] as string[],
    cleanup: [] as { action: string; status: string; error?: string }[],
    finishedAt: '',
  };
  let script: frida.Script | null = null;
  let supportsShutdown = false;
  let session: frida.Session | null = null;
  let device: frida.Device | null = null;
  let spawnedPid: number | null = null;
  let resumed = false;
  let finishing = false;
  let finishPromise: Promise<void> | null = null;
  let smokeTimer: ReturnType<typeof setTimeout> | null = null;
  let durationTimer: ReturnType<typeof setTimeout> | null = null;
  let resolveCompletion!: (code: number) => void;
  const completion = new Promise<number>(resolve => {
    resolveCompletion = resolve;
  });
  const deadline = Date.now() + options.timeoutMs;

  async function bounded<T>(
    operation: () => Promise<T>,
    label: string,
    cleanup = false
  ): Promise<T> {
    const limit = cleanup ? Math.min(options.timeoutMs, 5000) : Math.max(1, deadline - Date.now());
    return boundedOperation(operation, label, limit);
  }

  const onSignal = () => {
    void finish(options.smoke ? 1 : 0, 'signal');
  };
  const onDetached = (reason: unknown) => {
    if (!finishing) {
      void finish(1, `unexpected detach: ${reason}`);
    }
  };
  function finish(code: number, reason: string): Promise<void> {
    if (finishPromise) {
      return finishPromise;
    }
    finishing = true;
    outcome.reason = reason;
    finishPromise = (async () => {
      clearTimeout(smokeTimer ?? undefined);
      clearTimeout(durationTimer ?? undefined);
      process.off('SIGINT', onSignal);
      process.off('SIGTERM', onSignal);
      if (session) {
        session.detached.disconnect(onDetached);
      }
      const cleanup = async (action: string, fn: () => Promise<void>) => {
        try {
          await bounded(fn, action, true);
          outcome.cleanup.push({ action, status: 'passed' });
        } catch (error) {
          code = 1;
          outcome.cleanup.push({ action, status: 'failed', error: String(error) });
        }
      };
      if (script) {
        if (supportsShutdown) {
          await cleanup('agent.shutdown', async () => {
            await script!.exports.shutdown();
          });
        }
        await cleanup('script.unload', () => script!.unload());
      }
      if (session) {
        await cleanup('session.detach', () => session!.detach());
      }
      // A failed spawn must not leave an app suspended in the emulator.
      if (device && spawnedPid !== null && !resumed) {
        await cleanup('spawn.kill', () => device!.kill(spawnedPid!));
      }
      if (options.dumpEvents) {
        try {
          flushEvents(dumpEventsPath, traceEvents);
        } catch (error) {
          outcome.errors.push(`event dump: ${error}`);
          code = 1;
        }
      }
      outcome.status = code === 0 ? 'passed' : 'failed';
      outcome.finishedAt = new Date().toISOString();
      console.log(`[*] Exiting: ${reason}`);
      console.log('[CLEANUP]', JSON.stringify(outcome.cleanup));
      if (options.result) {
        try {
          fs.mkdirSync(path.dirname(options.result), { recursive: true });
          fs.writeFileSync(options.result, JSON.stringify(outcome, null, 2) + '\n');
        } catch (error) {
          console.error(`[!] Failed to save result: ${error}`);
          code = 1;
        }
      }
      resolveCompletion(code);
    })();
    return finishPromise;
  }

  try {
    if (!options.target && !options.frontmost) {
      throw new Error('target process not specified');
    }
    if (options.spawn && options.frontmost) {
      throw new Error('--spawn and --frontmost cannot be used together');
    }
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('--timeout-ms must be a positive number');
    }
    if (!Number.isFinite(options.durationMs) || options.durationMs < 0) {
      throw new Error('--duration-ms must be a nonnegative number');
    }
    if ((options.requiredModules.length || options.requiredRecipes.length) && !options.smoke) {
      throw new Error('--require-module/--require-recipe require --smoke');
    }
    if (
      [...options.requiredModules, ...options.requiredRecipes].some(id => !id || id.startsWith('-'))
    ) {
      throw new Error('required activation ID is missing');
    }
    if (!fs.existsSync(options.bundle)) {
      throw new Error(`bundle file not found: ${options.bundle}; run npm run build first`);
    }
    const config = JSON.parse(fs.readFileSync(options.config, 'utf8'));
    console.log(`[*] Connecting to ${options.device} device...`);
    device = await bounded(() => connect(options.device), 'connect');
    let pid: number;
    if (options.spawn) {
      pid = await bounded(() => device!.spawn([options.target]), 'spawn');
      spawnedPid = pid;
    } else if (options.frontmost) {
      const app = await bounded(() => device!.getFrontmostApplication(), 'frontmost');
      if (!app?.pid) {
        throw new Error('No frontmost application with an attachable PID');
      }
      pid = app.pid;
    } else {
      const processes = await bounded(() => device!.enumerateProcesses(), 'enumerate processes');
      const target =
        processes.find(p => p.name === options.target || String(p.pid) === options.target) ??
        processes.find(p => p.name.includes(options.target));
      pid = target?.pid ?? Number(options.target);
      if (!Number.isInteger(pid) || pid <= 0) {
        throw new Error(`Process not found: ${options.target}`);
      }
    }
    outcome.pid = pid;
    console.log(`[*] Attaching to PID ${pid}; bundle: ${options.bundle}`);
    script = (await attachScript(
      device,
      pid,
      fs.readFileSync(options.bundle, 'utf8'),
      'agentforge',
      bounded,
      owned => {
        session = owned;
        session!.detached.connect(onDetached);
      }
    )) as frida.Script;
    script.message.connect(message => {
      if (finishing) {
        return;
      }
      outcome.messages.push(message);
      if (options.verbose || message.type !== 'send') {
        console.log('[MSG]', JSON.stringify(message));
      }
      // Logging never substitutes for processing a message.
      if (message.type === 'error') {
        outcome.errors.push(message.stack || message.description);
        console.error('[!] Script error:', message.stack || message.description);
        if (options.smoke) {
          void finish(1, 'script error');
        }
        return;
      }
      if (message.type !== 'send') {
        return;
      }
      const payload = message.payload;
      if (payload?.shutdown === true) {
        supportsShutdown = true;
      }
      switch (payload?.type) {
        case 'log':
          console.log(`[${payload.namespace}] ${payload.message}`, ...(payload.args || []));
          break;
        case 'trace-event':
          traceEvents.push(payload.event);
          if (options.smoke && payload.event?.kind === 'error') {
            outcome.errors.push(
              `runtime ${payload.event.point}: ${payload.event.error?.message || 'structured error'}`
            );
            void finish(1, 'structured runtime error');
          }
          break;
        case 'module-status':
        case 'recipe-status': {
          const kind = payload.type === 'module-status' ? 'module' : 'recipe';
          const id = payload[`${kind}Id`];
          (kind === 'module' ? outcome.modules : outcome.recipes)[id] = payload.status;
          console.log(`[${kind.toUpperCase()}] ${payload.status} ${id}`);
          if (options.smoke && payload.status === 'failed') {
            outcome.errors.push(`${kind} ${id}: ${payload.error || 'activation failed'}`);
            void finish(1, `${kind} activation failed`);
          }
          break;
        }
        case 'loader-ready': {
          const missing = [
            ...options.requiredModules.filter(id => outcome.modules[id] !== 'activated'),
            ...options.requiredRecipes.filter(id => outcome.recipes[id] !== 'activated'),
          ];
          outcome.ready = true;
          if (options.smoke) {
            const failed =
              missing.length > 0 ||
              payload.stats?.failedModules > 0 ||
              payload.stats?.failedRecipes > 0;
            void finish(
              failed ? 1 : 0,
              failed ? `activation requirements failed: ${missing.join(', ')}` : 'loader ready'
            );
          }
          break;
        }
        case 'loader-error':
          outcome.errors.push(String(payload.error));
          if (options.smoke) {
            void finish(1, 'loader error');
          }
          break;
        case 'save_file':
          handleFileSave(payload);
          break;
        case 'device_fingerprint':
          console.log('[FINGERPRINT] Device fingerprint collected successfully');
          break;
        case 'collection_complete':
          if (!options.smoke && config?.flags?.['host.exitOnCollectionComplete'] === true) {
            void finish(0, 'collection complete');
          }
          break;
      }
    });
    process.on('SIGINT', onSignal);
    process.on('SIGTERM', onSignal);
    // Arm before load/post: ready or errors may arrive synchronously during either.
    if (options.smoke) {
      smokeTimer = setTimeout(
        () => {
          void finish(1, `smoke timeout ${options.timeoutMs}ms`);
        },
        Math.max(1, deadline - Date.now())
      );
    }
    await bounded(() => script!.load(), 'script load');
    if (!finishing) {
      script.post({ type: 'config', payload: config });
    }
    if (!finishing && options.spawn) {
      await bounded(() => device!.resume(pid), 'resume');
      resumed = true;
    }
    if (!finishing && options.durationMs > 0) {
      durationTimer = setTimeout(() => {
        void finish(options.smoke && !outcome.ready ? 1 : 0, 'duration elapsed');
      }, options.durationMs);
    }
  } catch (error) {
    outcome.errors.push(String(error));
    console.error('[!] Error:', error);
    await finish(1, String(error));
  }
  return completion;
}

export function main(argv = process.argv.slice(2)) {
  if (['list', 'plan'].includes(argv[0])) {
    return Promise.resolve(offlineCli(argv, projectRoot));
  }
  return argv[0] === 'run' ? compositionCli(argv, projectRoot) : runCli(argv);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main()
    .then(code => process.exit(code))
    .catch(error => {
      console.error('[!] Unhandled error:', error);
      process.exit(1);
    });
}
