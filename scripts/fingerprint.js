#!/usr/bin/env node

import { execSync, spawn } from 'child_process';

const SYSTEM_TARGETS = [
  'Settings',
  'Chrome',
  'Messages',
  'com.android.calculator2',
  'com.android.settings',
  'com.google.android.calculator',
];

function getAvailableProcesses() {
  try {
    const result = execSync('frida-ps -U', { encoding: 'utf8' });
    return result.split('\n').filter(line => line.trim() && !line.includes('PID'));
  } catch {
    try {
      const result = execSync('adb shell pm list packages | head -20', { encoding: 'utf8' });
      return result.split('\n').filter(line => line.includes('package:'));
    } catch {
      return [];
    }
  }
}

function selectTarget() {
  console.log('[*] Searching for a suitable target process...');

  try {
    const devices = execSync('adb devices', { encoding: 'utf8' });
    if (!devices.includes('device')) {
      console.log(
        '[WARN] No ADB devices found. Make sure your device is connected and USB debugging is enabled.'
      );
    }
  } catch {
    console.log('[WARN] ADB not found. Please install Android SDK platform-tools.');
  }

  const runningProcesses = getAvailableProcesses();
  console.log(`Found ${runningProcesses.length} potential target processes`);

  for (const target of SYSTEM_TARGETS.slice(0, 3)) {
    if (runningProcesses.some(line => line.includes(target))) {
      console.log(`[OK] Selected running process: ${target}`);
      return { target, shouldSpawn: false };
    }
  }

  const spawnTarget = 'com.android.calculator2';
  console.log(`[OK] Will spawn calculator app: ${spawnTarget}`);
  return { target: spawnTarget, shouldSpawn: true };
}

function createRunArgs(target, shouldSpawn) {
  const args = ['hosts/node-cli/run.js', '-c', 'configs/targets/fingerprint.json'];

  if (shouldSpawn) {
    args.push('-s');
  }

  args.push(target);
  return args;
}

function runFingerprinting() {
  const { target, shouldSpawn } = selectTarget();
  const args = createRunArgs(target, shouldSpawn);

  console.log('[*] Starting device fingerprint collection...');
  console.log(`Target: ${target} ${shouldSpawn ? '(spawn)' : '(attach)'}`);
  console.log(`Command: node ${args.join(' ')}`);
  console.log('');

  const child = spawn('node', args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  child.on('close', code => {
    if (code === 0) {
      console.log('\n[OK] Device fingerprint collection completed successfully.');
      console.log('[INFO] Check the output/ directory for the generated JSON file.');
    } else {
      console.error(`\n[FAIL] Fingerprinting failed with exit code ${code}`);
      console.log('\nTroubleshooting tips:');
      console.log('1. Make sure your Android device is connected via ADB');
      console.log('2. Enable USB debugging on your device');
      console.log('3. Try running: adb devices');
      console.log('4. Or specify a target manually: npm run fingerprint:manual <package_name>');
    }
  });

  child.on('error', err => {
    console.error('[FAIL] Failed to start fingerprinting:', err.message);
  });
}

function runManualFingerprinting() {
  const target = process.argv[3];
  if (!target) {
    console.error('[FAIL] Please specify a target package or process name');
    console.log('Usage: npm run fingerprint:manual <target>');
    console.log('Example: npm run fingerprint:manual com.example.app');
    process.exit(1);
  }

  const shouldSpawn = process.argv.includes('--spawn') || process.argv.includes('-s');
  const args = createRunArgs(target, shouldSpawn);

  console.log('[*] Starting manual device fingerprint collection...');
  console.log(`Target: ${target} ${shouldSpawn ? '(spawn)' : '(attach)'}`);
  console.log('');

  const child = spawn('node', args, {
    stdio: 'inherit',
    cwd: process.cwd(),
  });

  child.on('close', code => {
    process.exit(code ?? 0);
  });
}

const command = process.argv[2];

if (command === 'manual') {
  runManualFingerprinting();
} else {
  runFingerprinting();
}
