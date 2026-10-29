#!/usr/bin/env node

/**
 * Quick launcher for common target apps.
 * Keep this file thin: reusable logic belongs in packages/* or hosts/*.
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const APPS = {
  messages: {
    name: 'Google Messages',
    package: 'com.google.android.apps.messaging',
    config: 'configs/targets/messages.json',
    description: 'SMS app with SIM and network-oriented hooks',
  },
  telegram: {
    name: 'Telegram',
    package: 'org.telegram.messenger',
    config: 'configs/targets/telegram.json',
    description: 'Network tracing target',
  },
  wechat: {
    name: 'WeChat',
    package: 'com.tencent.mm',
    config: 'configs/targets/wechat.json',
    description: 'Broader network tracing target',
  },
  chrome: {
    name: 'Chrome',
    package: 'com.android.chrome',
    config: 'configs/targets/debug.json',
    description: 'General browser debugging target',
  },
  calculator: {
    name: 'Calculator',
    package: 'com.android.calculator2',
    config: 'configs/targets/default.json',
    description: 'Baseline smoke-test target',
  },
  settings: {
    name: 'Android Settings',
    package: 'com.android.settings',
    config: 'configs/targets/default.json',
    description: 'Stable system-app smoke and attach target',
  },
  detectapp: {
    name: 'DetectApp Sample',
    package: 'com.detect.app.sample',
    config: 'configs/targets/detect-app-sample.json',
    description: 'Spoofing and anti-detection validation target',
  },
};

function showHelp() {
  console.log(`
Frida app quick launcher

Usage: node scripts/test-apps.js <app> [options]

Available apps:
`);

  Object.entries(APPS).forEach(([key, app]) => {
    console.log(`  ${key.padEnd(12)} - ${app.name} (${app.description})`);
  });

  console.log(`
Options:
  -s, --spawn     Spawn the target app instead of attaching
  -F, --frontmost Attach to the current frontmost app instead of using the package lookup
  --smoke         Exit automatically after readiness or timeout
  --timeout-ms N  Timeout used by smoke mode
  -v, --verbose   Show full Frida message output
  -h, --help      Show this help message

Examples:
  node scripts/test-apps.js messages
  node scripts/test-apps.js messages -s
  node scripts/test-apps.js settings --frontmost --smoke
  node scripts/test-apps.js telegram -v
  node scripts/test-apps.js calculator

Package shortcuts:
  npm run test:messages
  npm run test:telegram
  npm run test:wechat
`);
}

function parseArgs() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }

  const appName = args[0];
  const spawn = args.includes('-s') || args.includes('--spawn');
  const frontmost = args.includes('-F') || args.includes('--frontmost');
  const verbose = args.includes('-v') || args.includes('--verbose');
  const smoke = args.includes('--smoke');
  const timeoutIndex = args.findIndex(arg => arg === '--timeout-ms');
  const timeoutMs = timeoutIndex >= 0 ? Number(args[timeoutIndex + 1]) : undefined;

  if (!APPS[appName]) {
    console.error(`Unknown app: ${appName}`);
    console.log('\nAvailable apps:', Object.keys(APPS).join(', '));
    process.exit(1);
  }

  return { appName, spawn, frontmost, verbose, smoke, timeoutMs };
}

async function runHook(appName, options) {
  const app = APPS[appName];
  const { spawn: shouldSpawn, frontmost, verbose, smoke, timeoutMs } = options;

  console.log(`Target: ${app.name}`);
  console.log(`Package: ${app.package}`);
  console.log(`Config: ${app.config}`);
  console.log(`Description: ${app.description}`);
  console.log(`Mode: ${frontmost ? 'frontmost attach' : shouldSpawn ? 'spawn' : 'attach'}`);
  console.log('');

  const cliArgs = ['hosts/node-cli/run.js', '-c', app.config];

  if (frontmost) {
    cliArgs.push('-F');
  } else {
    if (shouldSpawn) {
      cliArgs.push('-s');
    }
    cliArgs.push(app.package);
  }

  if (verbose) {
    cliArgs.push('-v');
  }

  if (smoke) {
    cliArgs.push('--smoke');
  }

  if (timeoutMs !== undefined && !Number.isNaN(timeoutMs)) {
    cliArgs.push('--timeout-ms', String(timeoutMs));
  }

  console.log(`Command: node ${cliArgs.join(' ')}`);
  console.log('Press Ctrl+C to exit.\n');

  return new Promise((resolve, reject) => {
    const child = spawn('node', cliArgs, {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    child.on('close', code => {
      if (code === 0) {
        console.log('\nHook session ended.');
        resolve();
      } else {
        console.log(`\nHook session ended with exit code ${code}.`);
        reject(new Error(`Process exited with code ${code}`));
      }
    });

    child.on('error', error => {
      console.error('\nExecution error:', error.message);
      reject(error);
    });

    process.on('SIGINT', () => {
      console.log('\nStopping...');
      child.kill('SIGINT');
    });
  });
}

async function main() {
  try {
    const { appName, spawn, frontmost, verbose, smoke, timeoutMs } = parseArgs();
    await runHook(appName, { spawn, frontmost, verbose, smoke, timeoutMs });
  } catch (error) {
    console.error('Execution failed:', error.message);
    process.exit(1);
  }
}

main();
