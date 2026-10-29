#!/usr/bin/env node

/**
 * 测试版验证工具 - 确保基本功能可用
 */

import * as frida from 'frida';

async function testFridaConnection() {
  console.log('🧪 测试 Frida 连接...');
  
  try {
    // 获取设备列表
    const devices = await frida.enumerateDevices();
    console.log(`📱 发现 ${devices.length} 个设备:`);
    
    devices.forEach((device, index) => {
      console.log(`   ${index + 1}. ${device.name} (${device.type})`);
    });
    
    // 尝试连接USB设备
    const usbDevice = await frida.getUsbDevice();
    console.log(`✅ 成功连接USB设备: ${usbDevice.name}`);
    
    // 检查应用是否安装
    const apps = await usbDevice.enumerateApplications();
    const detectApp = apps.find(app => app.identifier === 'com.detect.app.sample');
    
    if (detectApp) {
      console.log(`✅ 找到目标应用: ${detectApp.name}`);
      
      // 简单测试注入
      await testSimpleInjection(usbDevice);
      
    } else {
      console.log('❌ 未找到 DetectApp Sample 应用');
    }
    
  } catch (error) {
    console.error('❌ 测试失败:', error.message);
  }
}

async function testSimpleInjection(device) {
  console.log('🔬 测试简单注入...');
  
  try {
    // 启动应用
    const pid = await device.spawn(['com.detect.app.sample']);
    console.log(`🚀 应用已启动 (PID: ${pid})`);
    
    // 附加到进程
    const session = await device.attach(pid);
    console.log('🔗 已附加到进程');
    
    // 创建简单测试脚本
    const simpleScript = `
console.log('[TEST] 脚本已注入');

setTimeout(() => {
  Java.perform(() => {
    console.log('[TEST] Java环境准备完成');
    
    try {
      // 测试基本的Java类访问
      const Build = Java.use('android.os.Build');
      const brand = Build.BRAND.value;
      const model = Build.MODEL.value;
      
      console.log('[TEST] 设备品牌: ' + brand);  
      console.log('[TEST] 设备型号: ' + model);
      
      // 发送测试结果
      send({
        type: 'test-result',
        data: {
          brand: brand,
          model: model,
          success: true
        }
      });
      
    } catch (e) {
      console.log('[TEST] 错误: ' + e);
      send({
        type: 'test-error', 
        error: e.toString()
      });
    }
  });
}, 2000);
`;

    // 加载脚本
    const script = await session.createScript(simpleScript);
    
    script.message.connect((message) => {
      if (message.type === 'send') {
        const payload = message.payload;
        console.log('📨 收到消息:', JSON.stringify(payload, null, 2));
      }
    });
    
    await script.load();
    console.log('📜 脚本加载成功');
    
    // 恢复应用执行
    await device.resume(pid);
    console.log('▶️ 应用继续执行');
    
    // 等待5秒
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // 清理
    await script.unload();
    await session.detach();
    console.log('🧹 清理完成');
    
  } catch (error) {
    console.error('❌ 注入测试失败:', error.message);
  }
}

// 运行测试
console.log(`
🧪 Frida 连接测试工具
===================

测试 Frida 基本功能是否正常
`);

testFridaConnection().catch(console.error);
