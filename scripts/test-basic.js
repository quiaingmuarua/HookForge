#!/usr/bin/env node

/**
 * 基础测试脚本
 * 测试模块化 Frida 框架的基本功能
 */

import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');

console.log('🧪 开始基础功能测试...\n');

// 测试用例
const tests = [
  {
    name: '构建检查',
    command: 'npm',
    args: ['run', 'build'],
    description: '检查项目是否能正确构建',
  },
  {
    name: '类型检查',
    command: 'npm',
    args: ['run', 'type-check'],
    description: '检查 TypeScript 类型是否正确',
  },
  {
    name: '模块统计',
    command: 'npm',
    args: ['run', 'stats'],
    description: '显示模块注册统计信息',
  },
];

async function runTest(test) {
  return new Promise((resolve, reject) => {
    console.log(`📋 运行测试: ${test.name}`);
    console.log(`   描述: ${test.description}`);

    const process = spawn(test.command, test.args, {
      cwd: projectRoot,
      stdio: 'pipe',
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', data => {
      stdout += data.toString();
    });

    process.stderr.on('data', data => {
      stderr += data.toString();
    });

    process.on('close', code => {
      if (code === 0) {
        console.log(`   ✅ ${test.name} 通过`);
        if (stdout.trim()) {
          console.log(`   输出: ${stdout.trim()}`);
        }
        resolve({ success: true, stdout, stderr });
      } else {
        console.log(`   ❌ ${test.name} 失败 (退出码: ${code})`);
        if (stderr.trim()) {
          console.log(`   错误: ${stderr.trim()}`);
        }
        resolve({ success: false, stdout, stderr, code });
      }
      console.log('');
    });

    process.on('error', error => {
      console.log(`   💥 ${test.name} 执行错误: ${error.message}\n`);
      reject(error);
    });
  });
}

async function main() {
  let passedTests = 0;
  const totalTests = tests.length;

  for (const test of tests) {
    try {
      const result = await runTest(test);
      if (result.success) {
        passedTests++;
      }
    } catch (error) {
      console.error(`测试执行失败: ${error.message}`);
    }
  }

  console.log('📊 测试结果汇总:');
  console.log(`   总测试数: ${totalTests}`);
  console.log(`   通过: ${passedTests}`);
  console.log(`   失败: ${totalTests - passedTests}`);
  console.log(`   成功率: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

  if (passedTests === totalTests) {
    console.log('\n🎉 所有测试通过！框架已准备就绪。');
    console.log('\n💡 下一步可以尝试:');
    console.log('   npm run inject:test     # 测试注入计算器应用');
    console.log('   npm run inject:verbose  # 详细日志模式测试');
    console.log('   npm run dev            # 开发模式 (构建+注入)');
  } else {
    console.log('\n⚠️  部分测试失败，请检查上述错误信息。');
    process.exit(1);
  }
}

main().catch(error => {
  console.error('测试脚本执行失败:', error);
  process.exit(1);
});
