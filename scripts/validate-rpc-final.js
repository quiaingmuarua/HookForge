#!/usr/bin/env node

/**
 * 最终版RPC验证工具
 * 使用现有的CLI工具 + RPC通信获取验证结果
 */

import * as frida from 'frida';
import { spawn } from 'child_process';
import { writeFileSync } from 'fs';

const APP_PACKAGE = 'com.detect.app.sample';

async function main() {
  console.log(`
🎭 最终版RPC验证工具
===================

目标应用: ${APP_PACKAGE}
方法: CLI工具 + RPC通信
`);

  let device, session, script;

  try {
    // 1. 确保配置文件已推送
    console.log('📤 推送伪装配置...');
    await pushSpoofConfig();

    // 2. 连接设备  
    console.log('📱 连接USB设备...');
    device = await frida.getUsbDevice();
    console.log('✅ 设备连接成功:', device.name);

    // 3. 启动CLI Hook进程 (后台)
    console.log('🚀 启动CLI Hook进程...');
    const cliProcess = startCLIHook();

    // 等待CLI Hook建立
    await new Promise(resolve => setTimeout(resolve, 5000));

    // 4. 连接到已Hook的进程
    console.log('🔗 连接到已Hook的进程...');
    const processes = await device.enumerateProcesses();
    const targetProcess = processes.find(p => p.name.includes('com.detect.app.sample'));

    if (!targetProcess) {
      throw new Error('未找到目标进程');
    }

    session = await device.attach(targetProcess.pid);
    console.log('✅ 已附加到进程:', targetProcess.pid);

    // 5. 注入RPC验证脚本
    const rpcScript = `
console.log('[📞] RPC验证脚本已注入');

// 等待一下确保Hook已激活
setTimeout(() => {
  Java.perform(() => {
    console.log('[🎯] 开始RPC验证...');
    
    try {
      validateSpoofing();
    } catch (e) {
      console.log('[❌] RPC验证出错: ' + e);
    }
  });
}, 3000);

function validateSpoofing() {
  console.log('[🔍] 检查伪装效果...');
  
  const results = {
    buildTests: [],
    settingsTests: [],
    detectAppResult: null,
    timestamp: new Date().toISOString()
  };
  
  // 测试Build信息
  try {
    const Build = Java.use('android.os.Build');
    const BuildVersion = Java.use('android.os.Build$VERSION');
    
    const buildTests = [
      { name: 'BRAND', value: Build.BRAND.value, expected: 'samsung' },
      { name: 'MODEL', value: Build.MODEL.value, expected: 'SM-G998B' },
      { name: 'MANUFACTURER', value: Build.MANUFACTURER.value, expected: 'Samsung' },
      { name: 'VERSION.RELEASE', value: BuildVersion.RELEASE.value, expected: '12' },
      { name: 'VERSION.SDK_INT', value: BuildVersion.SDK_INT.value.toString(), expected: '31' }
    ];
    
    buildTests.forEach(test => {
      const success = test.value === test.expected;
      results.buildTests.push({
        ...test,
        success: success
      });
      
      console.log('[' + (success ? '✅' : '❌') + '] Build.' + test.name + ': ' + test.value + 
                 (success ? ' (伪装成功)' : ' (原始值，期望: ' + test.expected + ')'));
    });
    
  } catch (e) {
    console.log('[❌] Build测试失败: ' + e);
  }
  
  // 测试Settings  
  try {
    const ActivityThread = Java.use('android.app.ActivityThread');
    const app = ActivityThread.currentApplication();
    const context = app.getApplicationContext();
    
    const Settings = Java.use('android.provider.Settings$Secure');
    const androidId = Settings.getString(context.getContentResolver(), 'android_id');
    
    const settingsTest = {
      name: 'AndroidID',
      value: androidId,
      expected: '1234567890abcdef',
      success: androidId === '1234567890abcdef'
    };
    
    results.settingsTests.push(settingsTest);
    
    console.log('[' + (settingsTest.success ? '✅' : '❌') + '] AndroidID: ' + androidId + 
               (settingsTest.success ? ' (伪装成功)' : ' (原始值)'));
    
    // 测试DetectApp
    testDetectApp(context, results);
    
  } catch (e) {
    console.log('[❌] Context测试失败: ' + e);
  }
  
  // 发送最终结果
  setTimeout(() => {
    send({
      type: 'validation-final-result',
      data: results
    });
  }, 2000);
}

function testDetectApp(context, results) {
  console.log('[🎯] 测试DetectApp方法...');
  
  try {
    const className = 'com.detect.app.sample.fingerprint_detect.unique_fingerprint.SettingPropInfoCollect';
    let SettingPropInfoCollect = null;
    
    // 查找类
    Java.enumerateClassLoaders({
      onMatch: function(loader) {
        try {
          SettingPropInfoCollect = Java.ClassFactory.get(loader).use(className);
          return 'stop';
        } catch (e) {}
      },
      onComplete: function() {}
    });
    
    if (SettingPropInfoCollect) {
      console.log('[✅] 找到SettingPropInfoCollect类');
      
      const result = SettingPropInfoCollect.getAllInfo(context);
      const resultStr = result.toString();
      
      // 分析结果
      const spoofIndicators = ['samsung', 'SM-G998B', 'T-Mobile', '31000', '1234567890abcdef'];
      const foundIndicators = [];
      
      spoofIndicators.forEach(indicator => {
        if (resultStr.includes(indicator)) {
          foundIndicators.push(indicator);
          console.log('[✅] 检测到伪装指标: ' + indicator);
        } else {
          console.log('[❌] 未检测到: ' + indicator);
        }
      });
      
      results.detectAppResult = {
        success: true,
        resultLength: resultStr.length,
        resultPreview: resultStr.substring(0, 300),
        spoofIndicators: spoofIndicators,
        foundIndicators: foundIndicators,
        foundCount: foundIndicators.length,
        totalCount: spoofIndicators.length,
        successRate: (foundIndicators.length / spoofIndicators.length * 100).toFixed(1)
      };
      
      console.log('[📊] DetectApp结果: ' + foundIndicators.length + '/' + spoofIndicators.length + ' 个指标 (' + results.detectAppResult.successRate + '%)');
      
    } else {
      console.log('[❌] 未找到SettingPropInfoCollect类');
      results.detectAppResult = { success: false, error: 'Class not found' };
    }
    
  } catch (e) {
    console.log('[❌] DetectApp测试失败: ' + e);
    results.detectAppResult = { success: false, error: e.toString() };
  }
}
`;

    // 6. 加载RPC脚本
    script = await session.createScript(rpcScript);
    
    script.message.connect((message) => {
      if (message.type === 'send') {
        const payload = message.payload;
        
        if (payload.type === 'validation-final-result') {
          console.log('\\n📊 最终验证结果:');
          
          const data = payload.data;
          let totalTests = 0;
          let passedTests = 0;
          
          // 统计Build测试
          if (data.buildTests) {
            data.buildTests.forEach(test => {
              totalTests++;
              if (test.success) passedTests++;
            });
          }
          
          // 统计Settings测试
          if (data.settingsTests) {
            data.settingsTests.forEach(test => {
              totalTests++;
              if (test.success) passedTests++;
            });
          }
          
          // 统计DetectApp测试
          if (data.detectAppResult && data.detectAppResult.success) {
            totalTests += data.detectAppResult.totalCount;
            passedTests += data.detectAppResult.foundCount;
            
            console.log('\\n📱 DetectApp分析:');
            console.log('   结果长度:', data.detectAppResult.resultLength, '字符');
            console.log('   找到伪装指标:', data.detectAppResult.foundCount + '/' + data.detectAppResult.totalCount);
            console.log('   伪装成功率:', data.detectAppResult.successRate + '%');
            
            if (data.detectAppResult.foundIndicators.length > 0) {
              console.log('   检测到的指标:', data.detectAppResult.foundIndicators.join(', '));
            }
          }
          
          // 总体统计
          const overallSuccessRate = totalTests > 0 ? (passedTests / totalTests * 100).toFixed(1) : 0;
          
          console.log('\\n📈 总体结果:');
          console.log('   总测试数:', totalTests);
          console.log('   通过数:', passedTests);
          console.log('   失败数:', totalTests - passedTests);
          console.log('   总成功率:', overallSuccessRate + '%');
          
          // 保存详细结果
          writeFileSync('output/rpc-validation-result.json', JSON.stringify(payload.data, null, 2));
          console.log('\\n💾 详细结果已保存到: output/rpc-validation-result.json');
          
          // 最终判断
          if (overallSuccessRate >= 70) {
            console.log('\\n🎉 验证通过！伪装效果良好');
          } else if (overallSuccessRate >= 50) {
            console.log('\\n⚠️ 验证部分通过');
          } else {
            console.log('\\n❌ 验证未通过，请检查配置');
          }
        }
      }
    });

    await script.load();
    console.log('✅ RPC脚本已加载');

    // 7. 等待验证完成
    console.log('\\n⏱️ 等待验证完成（10秒）...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // 8. 清理CLI进程
    console.log('\\n🧹 清理资源...');
    cliProcess.kill();

  } catch (error) {
    console.error('❌ 验证失败:', error);
  } finally {
    if (script) {
      try {
        await script.unload();
        console.log('🧹 RPC脚本已卸载');
      } catch (e) {}
    }
    
    if (session) {
      try {
        await session.detach();
        console.log('🧹 会话已断开');
      } catch (e) {}
    }
  }

  console.log('\\n🏁 验证完成');
}

function startCLIHook() {
  console.log('🔧 启动后台CLI Hook...');
  
  const args = [
    'hosts/node-cli/run.js',
    '-c', 'configs/targets/detect-app-sample.json',
    '-s',
    APP_PACKAGE
  ];
  
  const cliProcess = spawn('node', args, {
    stdio: 'pipe'
  });
  
  // 输出重要日志
  cliProcess.stdout.on('data', (data) => {
    const text = data.toString();
    if (text.includes('spoofed') || text.includes('✅') || text.includes('Ready')) {
      process.stdout.write('  [CLI] ' + text);
    }
  });
  
  return cliProcess;
}

async function pushSpoofConfig() {
  return new Promise((resolve, reject) => {
    const adb = spawn('adb', ['push', 'examples/detect-app-spoof-demo.json', '/data/local/tmp/device_fingerprint.json']);
    
    adb.on('close', (code) => {
      if (code === 0) {
        console.log('✅ 伪装配置已推送');
        resolve();
      } else {
        reject(new Error('配置推送失败'));
      }
    });
  });
}

main().catch(console.error);
