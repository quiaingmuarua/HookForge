#!/usr/bin/env node

import frida from 'frida';

function parseArgs() {
  const args = process.argv.slice(2);
  const options = {
    target: 'com.android.settings',
    spawn: true,
    waitMs: 5000,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    switch (arg) {
      case '-F':
      case '--attach':
        options.spawn = false;
        break;
      case '--wait-ms':
        options.waitMs = Number(args[++i]);
        break;
      default:
        options.target = arg;
        break;
    }
  }

  return options;
}

async function main() {
  const options = parseArgs();
  const device = await frida.getUsbDevice();

  let pid;
  let session;

  try {
    if (options.spawn) {
      pid = await device.spawn([options.target]);
    } else {
      const processes = await device.enumerateProcesses();
      const process = processes.find(
        candidate =>
          candidate.name === options.target ||
          candidate.name.includes(options.target) ||
          candidate.pid.toString() === options.target
      );

      if (!process) {
        throw new Error(`Process not found: ${options.target}`);
      }

      pid = process.pid;
    }

    session = await device.attach(pid);
    const script = await session.createScript(`
      const emit = phase => {
        send({
          type: 'java-bridge-probe',
          phase,
          hasJavaGlobal: typeof Java !== 'undefined',
          javaAvailable: typeof Java !== 'undefined' ? Java.available : null,
          process: {
            id: Process.id,
            platform: Process.platform,
            arch: Process.arch,
          },
        });
      };

      emit('load');
      setTimeout(() => emit('t+2000ms'), 2000);
      setTimeout(() => emit('t+5000ms'), 5000);
    `);

    script.message.connect(message => {
      console.log(JSON.stringify(message));
    });

    await script.load();

    if (options.spawn) {
      await device.resume(pid);
    }

    await new Promise(resolve => setTimeout(resolve, options.waitMs));
    await script.unload();
    await session.detach();
  } finally {
    if (session) {
      try {
        await session.detach();
      } catch {
        // Ignore cleanup failures.
      }
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
