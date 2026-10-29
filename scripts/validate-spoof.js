#!/usr/bin/env node

/**
 * 自动化伪装验证脚本
 * 专门用于验证 DetectApp Sample 的 spoof 效果
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync, writeFileSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

const APP_PACKAGE = 'com.detect.app.sample';
const VALIDATION_CONFIG = 'configs/targets/spoof-validation.json';

let validationResults = {
  timestamp: new Date().toISOString(),
  appPackage: APP_PACKAGE,
  testResults: [],
  summary: {
    totalTests: 0,
    successfulSpoofs: 0,
    failedSpoofs: 0,
    successRate: 0
  }
};

function showHelp() {
  console.log(`
🎯 自动化伪装验证工具

用法: node scripts/validate-spoof.js [选项]

功能:
  1. 推送伪装配置到设备
  2. 启动DetectApp并注入Hook
  3. 自动调用指纹收集方法
  4. 验证伪装效果并生成报告

选项:
  -v, --verbose       详细日志输出
  -s, --spawn         重新启动应用（推荐）
  -c, --config <file> 使用自定义伪装配置文件
  -o, --output <file> 指定验证报告输出文件
  -h, --help          显示此帮助信息

示例:
  node scripts/validate-spoof.js                    # 基本验证
  node scripts/validate-spoof.js -s -v             # 重启应用 + 详细日志
  node scripts/validate-spoof.js -c my-config.json # 使用自定义配置

前提条件:
  - DetectApp应用已安装
  - 设备已连接并启用USB调试
  - Frida服务正在运行
`);
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
      return configIndex !== -1 && args[configIndex + 1] 
        ? args[configIndex + 1] 
        : 'examples/detect-app-spoof-demo.json';
    })(),
    output: (() => {
      const outputIndex = args.findIndex(arg => arg === '-o' || arg === '--output');
      return outputIndex !== -1 && args[outputIndex + 1] 
        ? args[outputIndex + 1] 
        : 'output/spoof-validation-report.json';
    })()
  };
}

async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    if (!options.quiet) {
      console.log(`🚀 执行: ${command} ${args.join(' ')}`);
    }
    
    const child = spawn(command, args, {
      cwd: projectRoot,
      stdio: options.quiet ? 'pipe' : 'inherit',
      ...options
    });

    let output = '';
    let errorOutput = '';
    
    if (options.quiet) {
      child.stdout.on('data', (data) => {
        output += data.toString();
      });
      child.stderr.on('data', (data) => {
        errorOutput += data.toString();
      });
    }

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ output, errorOutput });
      } else {
        reject(new Error(`Command failed with exit code ${code}: ${errorOutput}`));
      }
    });

    child.on('error', (error) => {
      reject(error);
    });

    // 设置超时
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
    console.log('✅ 设备连接正常');
    
    // 检查应用安装
    console.log('📱 检查DetectApp应用...');
    const { output } = await runCommand('adb', ['shell', 'pm', 'list', 'packages', APP_PACKAGE], { quiet: true });
    if (!output.includes(APP_PACKAGE)) {
      throw new Error(`应用 ${APP_PACKAGE} 未安装`);
    }
    console.log('✅ DetectApp应用已安装');
    
    // 检查配置文件
    console.log('📄 检查伪装配置文件...');
    await runCommand('adb', ['shell', 'ls', '/data/local/tmp/device_fingerprint.json'], { quiet: true });
    console.log('✅ 伪装配置文件已存在\n');
    
    return true;
  } catch (error) {
    console.error(`❌ 前提条件检查失败: ${error.message}`);
    return false;
  }
}

async function pushSpoofConfig(configFile) {
  console.log('📤 推送伪装配置文件...');
  
  try {
    // 确保配置文件存在
    const configPath = join(projectRoot, configFile);
    const configData = readFileSync(configPath, 'utf8');
    console.log(`📄 使用配置文件: ${configFile}`);
    
    // 推送到设备
    await runCommand('adb', ['push', configPath, '/data/local/tmp/device_fingerprint.json']);
    console.log('✅ 伪装配置已推送到设备\n');
    
    return true;
  } catch (error) {
    console.error(`❌ 配置文件推送失败: ${error.message}`);
    return false;
  }
}

async function runValidation(options) {
  console.log('🎭 开始自动化伪装验证...\n');
  
  const args = ['hosts/node-cli/run.js', '-c', VALIDATION_CONFIG, APP_PACKAGE];
  
  if (options.spawn) {
    args.splice(-1, 0, '-s');
  }
  
  if (options.verbose) {
    args.splice(-1, 0, '-v');
  }
  
  return new Promise((resolve, reject) => {
    console.log(`🚀 执行验证: node ${args.join(' ')}`);
    console.log('⏱️  验证将在15秒后自动结束...\n');
    
    const child = spawn('node', args, {
      cwd: projectRoot,
      stdio: 'pipe'
    });
    
    let validationOutput = '';
    let validationComplete = false;
    
    child.stdout.on('data', (data) => {
      const text = data.toString();
      validationOutput += text;
      
      // 实时显示重要日志
      if (text.includes('spoofed') || 
          text.includes('✅') || 
          text.includes('❌') ||
          text.includes('VALIDATION SUMMARY') ||
          text.includes('spoof-validation-report')) {
        process.stdout.write(text);
      }
      
      // 检查是否收到验证报告
      if (text.includes('spoof-validation-report')) {
        try {
          const reportMatch = text.match(/{"type":"spoof-validation-report","data":({.*?})}/);
          if (reportMatch) {
            const reportData = JSON.parse(reportMatch[1]);
            validationResults = reportData;
            validationComplete = true;
          }
        } catch (e) {
          console.log('⚠️  解析验证报告失败:', e.message);
        }
      }
    });
    
    child.stderr.on('data', (data) => {
      const text = data.toString();
      if (options.verbose) {
        process.stderr.write(text);
      }
    });
    
    child.on('close', (code) => {
      if (validationComplete) {
        resolve(validationOutput);
      } else {
        console.log('\n⚠️  验证过程结束，但未收到完整的验证报告');
        resolve(validationOutput);
      }
    });
    
    child.on('error', (error) => {
      reject(error);
    });
    
    // 15秒后自动结束
    setTimeout(() => {
      child.kill('SIGTERM');
      console.log('\n⏰ 验证时间结束');
    }, 15000);
  });
}

function generateReport(options) {
  console.log('\n📊 生成验证报告...');
  
  if (validationResults.testResults.length === 0) {
    console.log('⚠️  没有收到验证数据，生成基础报告');
    validationResults.summary = {
      totalTests: 0,
      successfulSpoofs: 0,
      failedSpoofs: 0,
      successRate: 0
    };
  }
  
  // 保存报告文件
  const reportPath = join(projectRoot, options.output);
  writeFileSync(reportPath, JSON.stringify(validationResults, null, 2));
  console.log(`💾 验证报告已保存: ${reportPath}`);
  
  // 打印摘要
  const { summary } = validationResults;
  console.log('\n📈 验证摘要:');
  console.log(`   测试总数: ${summary.totalTests}`);
  console.log(`   成功伪装: ${summary.successfulSpoofs}`);
  console.log(`   失败伪装: ${summary.failedSpoofs}`);
  console.log(`   成功率: ${summary.successRate.toFixed(1)}%`);
  
  if (summary.successRate >= 80) {
    console.log('\n🎉 伪装验证通过！(成功率 ≥ 80%)');
    return true;
  } else if (summary.successRate >= 50) {
    console.log('\n⚠️  伪装验证部分通过 (50% ≤ 成功率 < 80%)');
    return false;
  } else {
    console.log('\n❌ 伪装验证失败！(成功率 < 50%)');
    return false;
  }
}

async function main() {
  console.log(`
🎯 自动化伪装验证工具
目标应用: ${APP_PACKAGE}
验证配置: ${VALIDATION_CONFIG}
`);

  try {
    const options = parseArgs();
    
    // 1. 检查前提条件
    const prereqPassed = await checkPrerequisites();
    if (!prereqPassed) {
      process.exit(1);
    }
    
    // 2. 推送伪装配置
    const configPushed = await pushSpoofConfig(options.config);
    if (!configPushed) {
      process.exit(1);
    }
    
    // 3. 构建项目
    console.log('🔨 构建项目...');
    await runCommand('npm', ['run', 'build'], { quiet: true });
    console.log('✅ 项目构建完成\n');
    
    // 4. 运行验证
    await runValidation(options);
    
    // 5. 生成报告
    const passed = generateReport(options);
    
    console.log('\n🏁 验证完成！');
    process.exit(passed ? 0 : 1);
    
  } catch (error) {
    console.error('\n💥 验证失败:', error.message);
    process.exit(1);
  }
}

main();
