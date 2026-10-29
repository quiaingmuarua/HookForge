#!/usr/bin/env node

/**
 * 设备伪装验证演示脚本
 * 使用 com.detect.app.sample 应用验证 spoof 效果
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const APP_PACKAGE = 'com.detect.app.sample';
const CONFIG_FILE = 'configs/targets/detect-app-sample.json';

function showHelp() {
  console.log(`
🎭 设备伪装验证演示工具

用法: node scripts/spoof-validation-demo.js [选项]

功能:
  1. 收集原始设备指纹 (无伪装)
  2. 应用设备伪装配置
  3. 验证伪装效果
  4. 生成对比报告

选项:
  -v, --verbose       详细日志输出
  -s, --spawn         重新启动应用
  -c, --config <file> 使用自定义配置文件
  -h, --help          显示此帮助信息

前提条件:
  1. 安装 com.detect.app.sample 应用到设备
  2. 确保设备已root并安装frida-server
  3. 推送伪装配置文件到设备:
     adb push examples/universal-spoof-demo.json /data/local/tmp/device_fingerprint.json

示例:
  node scripts/spoof-validation-demo.js                # 基本验证
  node scripts/spoof-validation-demo.js -v             # 详细模式
  node scripts/spoof-validation-demo.js -s             # 重启应用
`);
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    console.log(`🚀 执行: ${command} ${args.join(' ')}`);
    
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: options.quiet ? 'pipe' : 'inherit',
      ...options
    });

    let output = '';
    if (options.quiet) {
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.stderr.on('data', (data) => {
        output += data.toString();
      });
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });

    // 处理超时
    if (options.timeout) {
      setTimeout(() => {
        child.kill('SIGTERM');
        reject(new Error('Command timeout'));
      }, options.timeout);
    }
  });
}

async function checkPrerequisites() {
  console.log('📋 检查前提条件...\n');
  
  try {
    // 检查设备连接
    console.log('🔍 检查设备连接...');
    await runCommand('adb', ['devices'], { quiet: true });
    console.log('✅ 设备连接正常\n');
    
    // 检查应用是否安装
    console.log('📱 检查目标应用...');
    const packages = await runCommand('adb', ['shell', 'pm', 'list', 'packages', APP_PACKAGE], { quiet: true });
    if (!packages.includes(APP_PACKAGE)) {
      throw new Error(`应用 ${APP_PACKAGE} 未安装`);
    }
    console.log(`✅ 应用 ${APP_PACKAGE} 已安装\n`);
    
    // 检查Frida服务
    console.log('🔧 检查Frida服务...');
    await runCommand('frida-ps', ['-U'], { quiet: true, timeout: 5000 });
    console.log('✅ Frida服务正常\n');
    
    return true;
  } catch (error) {
    console.error(`❌ 前提条件检查失败: ${error.message}`);
    return false;
  }
}

async function collectOriginalFingerprint() {
  console.log('📊 步骤1: 收集原始设备指纹...\n');
  
  try {
    // 使用fingerprint配置收集原始指纹
    await runCommand('node', [
      'hosts/node-cli/run.js',
      '-c', 'configs/targets/fingerprint.json',
      APP_PACKAGE
    ], { timeout: 30000 });
    
    console.log('✅ 原始指纹收集完成\n');
    return true;
  } catch (error) {
    console.error(`❌ 原始指纹收集失败: ${error.message}`);
    return false;
  }
}

async function applySpoofing(options) {
  console.log('🎭 步骤2: 应用设备伪装...\n');
  
  try {
    const args = ['hosts/node-cli/run.js', '-c', CONFIG_FILE, APP_PACKAGE];
    
    if (options.spawn) {
      args.splice(-1, 0, '-s');
    }
    
    if (options.verbose) {
      args.splice(-1, 0, '-v');
    }
    
    await runCommand('node', args, { timeout: 30000 });
    
    console.log('✅ 设备伪装应用完成\n');
    return true;
  } catch (error) {
    console.error(`❌ 设备伪装失败: ${error.message}`);
    return false;
  }
}

async function generateReport() {
  console.log('📊 步骤3: 生成验证报告...\n');
  
  try {
    // 检查输出目录中的指纹文件
    const outputFiles = await runCommand('ls', ['-la', 'output/'], { quiet: true });
    console.log('📁 生成的指纹文件:');
    console.log(outputFiles);
    
    console.log(`
🎯 验证完成！

📋 验证结果:
- 原始指纹已收集到 output/ 目录
- 伪装效果通过日志可见
- 建议对比伪装前后的设备信息

🔍 手动验证步骤:
1. 查看控制台输出中的 spoof 日志
2. 检查 output/ 目录中的 JSON 文件
3. 在应用中手动触发指纹收集功能

💡 提示:
- 查找日志中的 "(spoofed)" 标记
- 对比 SIM 信息、Build 信息等关键字段
- 验证 SettingPropInfoCollect.getAllInfo() 的输出
`);
    
    return true;
  } catch (error) {
    console.error(`❌ 报告生成失败: ${error.message}`);
    return false;
  }
}

function parseArgs() {
  const args = process.argv.slice(2);
  
  if (args.includes('-h') || args.includes('--help')) {
    showHelp();
    process.exit(0);
  }
  
  return {
    verbose: args.includes('-v') || args.includes('--verbose'),
    spawn: args.includes('-s') || args.includes('--spawn'),
    config: (() => {
      const configIndex = args.findIndex(arg => arg === '-c' || arg === '--config');
      return configIndex !== -1 && args[configIndex + 1] ? args[configIndex + 1] : CONFIG_FILE;
    })()
  };
}

async function main() {
  console.log(`
🎭 设备伪装验证演示
目标应用: ${APP_PACKAGE}
配置文件: ${CONFIG_FILE}
`);

  try {
    const options = parseArgs();
    
    // 检查前提条件
    const prereqPassed = await checkPrerequisites();
    if (!prereqPassed) {
      process.exit(1);
    }
    
    // 收集原始指纹
    const originalPassed = await collectOriginalFingerprint();
    if (!originalPassed) {
      console.log('⚠️  原始指纹收集失败，继续执行伪装验证...\n');
    }
    
    // 应用伪装
    const spoofPassed = await applySpoofing(options);
    if (!spoofPassed) {
      console.error('❌ 伪装验证失败');
      process.exit(1);
    }
    
    // 生成报告
    await generateReport();
    
    console.log('🎉 验证演示完成！');
    
  } catch (error) {
    console.error('💥 执行失败:', error.message);
    process.exit(1);
  }
}

main();
