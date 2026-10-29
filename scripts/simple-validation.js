#!/usr/bin/env node

/**
 * 简化版伪装验证工具
 * 使用 Frida Node.js API 获取实时验证结果
 */

import * as frida from 'frida';

const APP_PACKAGE = 'com.detect.app.sample';

async function main() {
  console.log(`
🎯 简化版 Frida 伪装验证工具
==========================

目标应用: ${APP_PACKAGE}
验证方法: RPC 实时通信
`);

  let device, session, script;

  try {
    // 连接设备
    console.log('📱 连接USB设备...');
    device = await frida.getUsbDevice();
    console.log('✅ 设备连接成功');

    // 启动应用
    console.log(`🚀 启动应用: ${APP_PACKAGE}`);
    const pid = await device.spawn([APP_PACKAGE]);
    console.log(`✅ 应用已启动 (PID: ${pid})`);

    // 附加到进程
    console.log('🔗 附加到进程...');
    session = await device.attach(pid);
    console.log('✅ 进程附加成功');

    // 创建验证脚本
    const scriptCode = `
console.log('[🎭] 验证脚本已加载');

// 等待Java环境准备
setTimeout(() => {
  Java.perform(() => {
    console.log('[✅] Java环境准备完成');
    
    try {
      // 获取Context
      const ActivityThread = Java.use('android.app.ActivityThread');
      const app = ActivityThread.currentApplication();
      
      if (!app) {
        console.log('[❌] 无法获取Application Context');
        return;
      }
      
      const context = app.getApplicationContext();
      console.log('[📱] Context获取成功: ' + context);
      
      // 验证Build信息伪装
      validateBuildInfo();
      
      // 验证Settings伪装  
      validateSettings(context);
      
      // 尝试验证DetectApp
      validateDetectApp(context);
      
      // 发送验证完成信号
      setTimeout(() => {
        send({ type: 'validation-complete', message: '验证完成' });
      }, 2000);
      
    } catch (e) {
      console.log('[❌] 验证过程出错: ' + e);
      send({ type: 'validation-error', error: e.toString() });
    }
  });
}, 3000);

function validateBuildInfo() {
  console.log('[🔍] 验证Build信息...');
  
  try {
    const Build = Java.use('android.os.Build');
    const brand = Build.BRAND.value;
    const model = Build.MODEL.value;
    const manufacturer = Build.MANUFACTURER.value;
    
    console.log('[📊] Brand: ' + brand);
    console.log('[📊] Model: ' + model);
    console.log('[📊] Manufacturer: ' + manufacturer);
    
    // 检查是否被伪装
    if (brand === 'samsung') {
      console.log('[✅] Brand伪装成功: samsung');
    }
    if (model === 'SM-G998B') {
      console.log('[✅] Model伪装成功: SM-G998B');  
    }
    if (manufacturer === 'Samsung') {
      console.log('[✅] Manufacturer伪装成功: Samsung');
    }
    
    const BuildVersion = Java.use('android.os.Build$VERSION');
    const release = BuildVersion.RELEASE.value;
    const sdkInt = BuildVersion.SDK_INT.value;
    
    console.log('[📊] Android Version: ' + release + ' (API ' + sdkInt + ')');
    
    if (release === '12') {
      console.log('[✅] Android版本伪装成功: 12');
    }
    if (sdkInt === 31) {
      console.log('[✅] API Level伪装成功: 31');
    }
    
  } catch (e) {
    console.log('[❌] Build信息验证失败: ' + e);
  }
}

function validateSettings(context) {
  console.log('[🔍] 验证Settings伪装...');
  
  try {
    const Settings = Java.use('android.provider.Settings$Secure');
    const androidId = Settings.getString(context.getContentResolver(), 'android_id');
    
    console.log('[📊] Android ID: ' + androidId);
    
    if (androidId === '1234567890abcdef') {
      console.log('[✅] Android ID伪装成功: 1234567890abcdef');
    } else {
      console.log('[❌] Android ID伪装失败，当前值: ' + androidId);
    }
    
  } catch (e) {
    console.log('[❌] Settings验证失败: ' + e);
  }
}

function validateDetectApp(context) {
  console.log('[🔍] 验证DetectApp方法...');
  
  try {
    // 查找DetectApp的类
    const className = 'com.detect.app.sample.fingerprint_detect.unique_fingerprint.SettingPropInfoCollect';
    let targetClass = null;
    
    Java.enumerateClassLoaders({
      onMatch: function(loader) {
        try {
          targetClass = Java.ClassFactory.get(loader).use(className);
          console.log('[✅] 找到SettingPropInfoCollect类');
          return 'stop';
        } catch (e) {
          // 继续查找
        }
      },
      onComplete: function() {}
    });
    
    if (targetClass) {
      console.log('[🎯] 调用getAllInfo()方法...');
      const result = targetClass.getAllInfo(context);
      const resultStr = result.toString();
      
      console.log('[📊] DetectApp结果长度: ' + resultStr.length);
      console.log('[📊] 结果预览: ' + resultStr.substring(0, 200) + '...');
      
      // 检查关键伪装指标
      let spoofCount = 0;
      const checks = [
        ['samsung', 'Brand伪装'],
        ['SM-G998B', 'Model伪装'], 
        ['T-Mobile', 'SIM运营商伪装'],
        ['31000', 'SIM代码伪装'],
        ['1234567890abcdef', 'Android ID伪装']
      ];
      
      checks.forEach(([value, description]) => {
        if (resultStr.includes(value)) {
          console.log('[✅] ' + description + '检测成功: ' + value);
          spoofCount++;
        } else {
          console.log('[❌] ' + description + '未检测到: ' + value);
        }
      });
      
      const successRate = (spoofCount / checks.length * 100).toFixed(1);
      console.log('[📈] DetectApp伪装成功率: ' + successRate + '% (' + spoofCount + '/' + checks.length + ')');
      
      // 发送详细结果
      send({
        type: 'detectapp-result',
        result: resultStr,
        spoofCount: spoofCount,
        totalChecks: checks.length,
        successRate: parseFloat(successRate)
      });
      
    } else {
      console.log('[⚠] 未找到SettingPropInfoCollect类，可能应用未完全加载');
    }
    
  } catch (e) {
    console.log('[❌] DetectApp验证失败: ' + e);
  }
}
`;

    // 加载脚本
    console.log('📜 加载验证脚本...');
    script = await session.createScript(scriptCode);
    
    // 设置消息处理
    script.message.connect((message) => {
      if (message.type === 'send') {
        const payload = message.payload;
        
        if (payload.type === 'detectapp-result') {
          console.log(`\n📊 DetectApp验证结果:`);
          console.log(`   成功率: ${payload.successRate}%`);
          console.log(`   检测到: ${payload.spoofCount}/${payload.totalChecks} 个伪装指标`);
          
          if (payload.successRate >= 80) {
            console.log('🎉 验证通过！伪装效果优秀');
          } else if (payload.successRate >= 60) {
            console.log('⚠️ 验证部分通过，伪装效果良好');
          } else {
            console.log('❌ 验证未通过，请检查伪装配置');
          }
        } else if (payload.type === 'validation-complete') {
          console.log('\n✅ 验证流程完成');
        } else if (payload.type === 'validation-error') {
          console.log('\n❌ 验证过程出错:', payload.error);
        }
      }
    });
    
    await script.load();
    console.log('✅ 脚本加载成功');

    // 恢复应用执行
    console.log('▶️ 恢复应用执行...');
    await device.resume(pid);
    console.log('✅ 应用继续运行\n');

    // 等待验证完成
    console.log('⏱️ 等待验证完成（15秒）...');
    await new Promise(resolve => setTimeout(resolve, 15000));

    console.log('\n🏁 验证会话结束');

  } catch (error) {
    console.error('❌ 验证失败:', error);
  } finally {
    // 清理资源
    if (script) {
      try {
        await script.unload();
        console.log('🧹 脚本已卸载');
      } catch (e) {}
    }
    
    if (session) {
      try {
        await session.detach();
        console.log('🧹 会话已断开');
      } catch (e) {}
    }
  }
}

import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ESM模块执行检查
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
