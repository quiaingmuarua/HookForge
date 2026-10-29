#!/usr/bin/env node

/**
 * TypeScript 版自动化伪装验证工具
 * 使用 Frida Node.js API 和 RPC 通信获取验证结果
 */

import * as frida from 'frida';
import { readFileSync, writeFileSync } from 'fs';
import { spawn } from 'child_process';

const APP_PACKAGE = 'com.detect.app.sample';
const SPOOF_CONFIG = 'examples/detect-app-spoof-demo.json';

interface SpoofValidationResult {
  method: string;
  originalValue: any;
  spoofedValue: any;
  isSuccess: boolean;
  timestamp: number;
}

interface ValidationReport {
  appPackage: string;
  testResults: SpoofValidationResult[];
  detectAppResult?: string;
  summary: {
    totalTests: number;
    successfulSpoofs: number;
    failedSpoofs: number;
    successRate: number;
  };
  timestamp: string;
}

class SpoofValidator {
  private results: SpoofValidationResult[] = [];
  private detectAppResult: string = '';
  private device?: frida.Device;
  private session?: frida.Session;

  async log(message: string, level: 'INFO' | 'ERROR' | 'SUCCESS' = 'INFO') {
    const timestamp = new Date().toLocaleTimeString();
    const emoji = level === 'SUCCESS' ? '✅' : level === 'ERROR' ? '❌' : '📝';
    console.log(`[${timestamp}] ${emoji} ${message}`);
  }

  async runCommand(cmd: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const process = spawn(cmd[0], cmd.slice(1), { stdio: 'pipe' });
      let output = '';
      let error = '';

      process.stdout.on('data', (data) => {
        output += data.toString();
      });

      process.stderr.on('data', (data) => {
        error += data.toString();
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve(output.trim());
        } else {
          reject(new Error(`Command failed: ${error}`));
        }
      });
    });
  }

  async checkPrerequisites(): Promise<boolean> {
    await this.log('检查前提条件...');
    
    try {
      // 检查设备连接
      const devices = await this.runCommand(['adb', 'devices']);
      if (!devices.includes('device')) {
        await this.log('没有连接的Android设备', 'ERROR');
        return false;
      }

      // 检查应用安装
      const packages = await this.runCommand(['adb', 'shell', 'pm', 'list', 'packages', APP_PACKAGE]);
      if (!packages.includes(APP_PACKAGE)) {
        await this.log(`应用 ${APP_PACKAGE} 未安装`, 'ERROR');
        return false;
      }

      await this.log('前提条件检查通过', 'SUCCESS');
      return true;
    } catch (error) {
      await this.log(`前提条件检查失败: ${error}`, 'ERROR');
      return false;
    }
  }

  async pushSpoofConfig(): Promise<boolean> {
    await this.log('推送伪装配置到设备...');
    
    try {
      await this.runCommand(['adb', 'push', SPOOF_CONFIG, '/data/local/tmp/device_fingerprint.json']);
      await this.log('伪装配置推送成功', 'SUCCESS');
      return true;
    } catch (error) {
      await this.log(`配置推送失败: ${error}`, 'ERROR');
      return false;
    }
  }

  createValidationScript(): string {
    return `
// 验证脚本 - 使用RPC与主机通信
const VALIDATION_SCRIPT = {
  results: [],
  
  log: function(message) {
    console.log('[VALIDATOR] ' + message);
  },
  
  // RPC 导出的方法
  startValidation: function() {
    this.log('🎯 Starting spoof validation...');
    
    setTimeout(() => {
      Java.perform(() => {
        this.log('Java环境准备完成');
        
        try {
          // 获取Application Context
          const ActivityThread = Java.use('android.app.ActivityThread');
          const app = ActivityThread.currentApplication();
          
          if (!app) {
            this.log('❌ Application context 不可用');
            return;
          }
          
          const context = app.getApplicationContext();
          this.log('✅ 获取到 Context: ' + context);
          
          // 验证DetectApp专用方法
          this.validateDetectApp(context);
          
          // 验证系统API
          this.validateSystemAPIs(context);
          
          // 发送结果
          setTimeout(() => {
            send({
              type: 'validation-complete',
              results: this.results,
              detectAppResult: this.detectAppResult || ''
            });
          }, 1000);
          
        } catch (e) {
          this.log('❌ 验证过程出错: ' + e);
          send({
            type: 'validation-error',
            error: e.toString()
          });
        }
      });
    }, 2000);
  },
  
  validateDetectApp: function(context) {
    this.log('🔍 验证DetectApp方法...');
    
    try {
      // 枚举ClassLoader查找目标类
      const className = 'com.detect.app.sample.fingerprint_detect.unique_fingerprint.SettingPropInfoCollect';
      let targetClass = null;
      
      Java.enumerateClassLoaders({
        onMatch: (loader) => {
          try {
            targetClass = Java.ClassFactory.get(loader).use(className);
            this.log('✅ 找到 SettingPropInfoCollect 类');
            return 'stop';
          } catch (e) {
            // 继续查找
          }
        },
        onComplete: () => {}
      });
      
      if (targetClass) {
        this.log('🎯 调用 getAllInfo()...');
        const result = targetClass.getAllInfo(context);
        this.detectAppResult = result.toString();
        this.log('📊 DetectApp结果: ' + this.detectAppResult.substring(0, 200) + '...');
        
        // 分析结果
        this.analyzeDetectAppResult(this.detectAppResult);
      } else {
        this.log('⚠ 未找到 SettingPropInfoCollect 类');
      }
      
    } catch (e) {
      this.log('❌ DetectApp验证失败: ' + e);
    }
  },
  
  analyzeDetectAppResult: function(result) {
    this.log('🔍 分析DetectApp结果中的伪装指标...');
    
    const expectedValues = {
      'samsung': 'Brand伪装',
      'SM-G998B': 'Model伪装',
      'T-Mobile': 'SIM运营商伪装',
      '31000': 'SIM运营商代码伪装',
      '1234567890abcdef': 'Android ID伪装',
      '12': 'Android版本伪装'
    };
    
    for (const [value, description] of Object.entries(expectedValues)) {
      const found = result.includes(value);
      this.results.push({
        method: 'DetectApp.' + description,
        originalValue: 'unknown',
        spoofedValue: value,
        isSuccess: found,
        timestamp: Date.now()
      });
      
      if (found) {
        this.log('✅ ' + description + ' 检测到: ' + value);
      } else {
        this.log('❌ ' + description + ' 未检测到: ' + value);
      }
    }
  },
  
  validateSystemAPIs: function(context) {
    this.log('🔍 验证系统API伪装效果...');
    
    try {
      // 验证Build信息
      const Build = Java.use('android.os.Build');
      this.checkBuildField('BRAND', Build.BRAND.value, 'samsung');
      this.checkBuildField('MANUFACTURER', Build.MANUFACTURER.value, 'Samsung');
      this.checkBuildField('MODEL', Build.MODEL.value, 'SM-G998B');
      
      const BuildVersion = Java.use('android.os.Build$VERSION');
      this.checkBuildField('RELEASE', BuildVersion.RELEASE.value, '12');
      this.checkBuildField('SDK_INT', BuildVersion.SDK_INT.value.toString(), '31');
      
      // 验证Android ID
      const Settings = Java.use('android.provider.Settings$Secure');
      const androidId = Settings.getString(context.getContentResolver(), 'android_id');
      this.checkSystemValue('Android_ID', androidId, '1234567890abcdef');
      
      // 验证TelephonyManager (如果有权限)
      try {
        const telephonyService = context.getSystemService('phone');
        if (telephonyService) {
          const simOperator = telephonyService.getSimOperator();
          const simOperatorName = telephonyService.getSimOperatorName();
          
          this.checkSystemValue('SIM_Operator', simOperator, '31000');
          this.checkSystemValue('SIM_OperatorName', simOperatorName, 'T-Mobile');
        }
      } catch (e) {
        this.log('⚠ TelephonyManager 访问受限: ' + e);
      }
      
    } catch (e) {
      this.log('❌ 系统API验证失败: ' + e);
    }
  },
  
  checkBuildField: function(field, actual, expected) {
    const isSuccess = actual === expected;
    this.results.push({
      method: 'Build.' + field,
      originalValue: isSuccess ? 'unknown' : actual,
      spoofedValue: expected,
      isSuccess: isSuccess,
      timestamp: Date.now()
    });
    
    if (isSuccess) {
      this.log('✅ Build.' + field + ' 伪装成功: ' + actual);
    } else {
      this.log('❌ Build.' + field + ' 伪装失败: ' + actual + ' (期望: ' + expected + ')');
    }
  },
  
  checkSystemValue: function(name, actual, expected) {
    const isSuccess = actual === expected;
    this.results.push({
      method: 'System.' + name,
      originalValue: isSuccess ? 'unknown' : actual,
      spoofedValue: expected,
      isSuccess: isSuccess,
      timestamp: Date.now()
    });
    
    if (isSuccess) {
      this.log('✅ ' + name + ' 伪装成功: ' + actual);
    } else {
      this.log('❌ ' + name + ' 伪装失败: ' + actual + ' (期望: ' + expected + ')');
    }
  }
};

// RPC导出
rpc.exports = {
  startValidation: VALIDATION_SCRIPT.startValidation.bind(VALIDATION_SCRIPT)
};

// 自动开始验证
VALIDATION_SCRIPT.startValidation();
`;
  }

  async runValidation(): Promise<ValidationReport> {
    await this.log('🚀 启动Frida验证会话...');

    try {
      // 连接设备
      this.device = await frida.getUsbDevice();
      await this.log('✅ 连接到USB设备');

      // 启动应用
      const pid = await this.device.spawn([APP_PACKAGE]);
      await this.log(`✅ 启动应用: ${APP_PACKAGE} (PID: ${pid})`);

      // 附加到进程
      this.session = await this.device.attach(pid);
      await this.log('✅ 附加到进程');

      // 创建并加载脚本
      const scriptSource = this.createValidationScript();
      const script = await this.session.createScript(scriptSource);
      
      // 设置消息处理
      script.message.connect((message) => {
        if (message.type === 'send') {
          const payload = message.payload;
          
          if (payload.type === 'validation-complete') {
            this.results = payload.results;
            this.detectAppResult = payload.detectAppResult;
            this.log('📊 收到验证结果');
          } else if (payload.type === 'validation-error') {
            this.log(`验证过程出错: ${payload.error}`, 'ERROR');
          }
        } else if (message.type === 'error') {
          this.log(`脚本错误: ${message.description}`, 'ERROR');
        }
      });

      await script.load();
      await this.log('✅ 脚本加载成功');

      // 恢复应用执行
      await this.device.resume(pid);
      await this.log('✅ 应用继续执行');

      // 等待验证完成
      await this.log('⏱️ 等待验证完成（10秒）...');
      await new Promise(resolve => setTimeout(resolve, 10000));

      // 调用RPC方法开始验证
      try {
        await script.exports?.startValidation?.();
        await this.log('🎯 触发验证流程');
        
        // 再等待5秒收集结果
        await new Promise(resolve => setTimeout(resolve, 5000));
      } catch (e) {
        await this.log(`RPC调用失败: ${e}`, 'ERROR');
      }

      return this.generateReport();

    } catch (error) {
      await this.log(`验证失败: ${error}`, 'ERROR');
      throw error;
    }
  }

  generateReport(): ValidationReport {
    const successfulSpoofs = this.results.filter(r => r.isSuccess).length;
    const failedSpoofs = this.results.filter(r => !r.isSuccess).length;
    const successRate = this.results.length > 0 ? (successfulSpoofs / this.results.length) * 100 : 0;

    const report: ValidationReport = {
      appPackage: APP_PACKAGE,
      testResults: this.results,
      detectAppResult: this.detectAppResult,
      summary: {
        totalTests: this.results.length,
        successfulSpoofs,
        failedSpoofs,
        successRate
      },
      timestamp: new Date().toISOString()
    };

    // 保存报告
    writeFileSync('output/spoof-validation-report-ts.json', JSON.stringify(report, null, 2));

    return report;
  }

  async cleanup() {
    try {
      if (this.session) {
        await this.session.detach();
        await this.log('🧹 会话已断开');
      }
    } catch (e) {
      await this.log(`清理过程出错: ${e}`, 'ERROR');
    }
  }

  async run(): Promise<boolean> {
    await this.log('🎭 开始TypeScript版自动化伪装验证');

    try {
      // 1. 检查前提条件
      if (!(await this.checkPrerequisites())) {
        return false;
      }

      // 2. 推送配置
      if (!(await this.pushSpoofConfig())) {
        return false;
      }

      // 3. 等待配置生效
      await new Promise(resolve => setTimeout(resolve, 2000));

      // 4. 运行验证
      const report = await this.runValidation();

      // 5. 输出结果
      await this.log('📈 验证摘要:');
      await this.log(`   总测试数: ${report.summary.totalTests}`);
      await this.log(`   成功伪装: ${report.summary.successfulSpoofs}`);
      await this.log(`   失败伪装: ${report.summary.failedSpoofs}`);
      await this.log(`   成功率: ${report.summary.successRate.toFixed(1)}%`);

      if (report.detectAppResult) {
        await this.log('📱 DetectApp结果预览:');
        console.log(report.detectAppResult.substring(0, 300) + '...');
      }

      const passed = report.summary.successRate >= 60;
      if (passed) {
        await this.log('🎉 验证通过！伪装功能正常工作', 'SUCCESS');
      } else {
        await this.log('⚠️ 验证未完全通过，请检查配置', 'ERROR');
      }

      return passed;

    } catch (error) {
      await this.log(`验证过程出错: ${error}`, 'ERROR');
      return false;
    } finally {
      await this.cleanup();
    }
  }
}

async function main() {
  console.log(`
🎭 TypeScript版 Frida 伪装验证工具
====================================

使用 Frida Node.js API 和 RPC 通信
实时获取 Hook 结果并自动分析验证

目标应用: ${APP_PACKAGE}
伪装配置: ${SPOOF_CONFIG}
`);

  const validator = new SpoofValidator();
  const success = await validator.run();

  process.exit(success ? 0 : 1);
}

if (require.main === module) {
  main().catch(console.error);
}

export { SpoofValidator };
