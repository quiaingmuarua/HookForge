#!/usr/bin/env node

/**
 * 超级快速测试脚本
 * 自动检测设备上运行的应用并提供快速hook选项
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

// 常见应用映射
const APP_MAPPING = {
  'com.google.android.apps.messaging': { name: 'Messages', config: 'messages.json' },
  'org.telegram.messenger': { name: 'Telegram', config: 'telegram.json' },
  'com.tencent.mm': { name: 'WeChat', config: 'wechat.json' },
  'com.android.chrome': { name: 'Chrome', config: 'debug.json' },
  'com.android.calculator2': { name: 'Calculator', config: 'default.json' },
  'com.whatsapp': { name: 'WhatsApp', config: 'debug.json' },
  'com.facebook.katana': { name: 'Facebook', config: 'debug.json' },
  'com.instagram.android': { name: 'Instagram', config: 'debug.json' },
};

async function getRunningApps() {
  return new Promise((resolve, reject) => {
    const child = spawn('frida-ps', ['-U'], {
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', data => {
      stdout += data.toString();
    });

    child.stderr.on('data', data => {
      stderr += data.toString();
    });

    child.on('close', code => {
      if (code !== 0) {
        reject(new Error(`frida-ps failed: ${stderr}`));
        return;
      }

      const lines = stdout.trim().split('\n').slice(1); // 跳过表头
      const processes = lines.map(line => {
        const parts = line.trim().split(/\s+/);
        const pid = parts[0];
        const name = parts.slice(1).join(' ');
        return { pid: parseInt(pid), name };
      });

      resolve(processes);
    });

    child.on('error', reject);
  });
}

function findTargetApps(processes) {
  const targets = [];

  for (const process of processes) {
    if (APP_MAPPING[process.name]) {
      targets.push({
        ...process,
        displayName: APP_MAPPING[process.name].name,
        config: APP_MAPPING[process.name].config,
      });
    }
  }

  return targets;
}

async function selectTarget(targets) {
  if (targets.length === 0) {
    console.log('❌ 未找到支持的应用正在运行');
    console.log(
      '\n💡 支持的应用:',
      Object.values(APP_MAPPING)
        .map(app => app.name)
        .join(', ')
    );
    console.log('\n请先启动目标应用，然后重新运行此脚本');
    process.exit(1);
  }

  if (targets.length === 1) {
    return targets[0];
  }

  console.log('🎯 发现多个可hook的应用:');
  targets.forEach((target, index) => {
    console.log(`  ${index + 1}. ${target.displayName} (PID: ${target.pid})`);
  });

  // 为了演示，选择第一个
  console.log(`\n🚀 自动选择: ${targets[0].displayName}`);
  return targets[0];
}

async function hookTarget(target) {
  console.log(`\n📱 目标应用: ${target.displayName}`);
  console.log(`📦 包名: ${target.name}`);
  console.log(`🆔 PID: ${target.pid}`);
  console.log(`⚙️  配置: ${target.config}`);
  console.log('');

  const cliArgs = ['hosts/node-cli/run.js', '-c', `configs/targets/${target.config}`, target.name];

  console.log(`🚀 执行: node ${cliArgs.join(' ')}`);
  console.log('📍 按 Ctrl+C 退出\n');

  return new Promise((resolve, reject) => {
    const child = spawn('node', cliArgs, {
      cwd: projectRoot,
      stdio: 'inherit',
    });

    child.on('close', code => {
      if (code === 0) {
        console.log('\n✅ Hook 会话正常结束');
        resolve();
      } else {
        console.log(`\n⚠️  Hook 会话结束 (退出码: ${code})`);
        resolve(); // 不当作错误，因为用户可能主动退出
      }
    });

    child.on('error', error => {
      console.error('\n💥 执行错误:', error.message);
      reject(error);
    });

    // 处理退出信号
    process.on('SIGINT', () => {
      console.log('\n🛑 正在停止...');
      child.kill('SIGINT');
    });
  });
}

async function main() {
  try {
    console.log('🔍 正在扫描设备上的应用...\n');

    const processes = await getRunningApps();
    const targets = findTargetApps(processes);
    const target = await selectTarget(targets);

    await hookTarget(target);
  } catch (error) {
    console.error('❌ 执行失败:', error.message);
    process.exit(1);
  }
}

main();
