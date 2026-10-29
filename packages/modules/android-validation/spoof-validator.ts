import { Ctx, ModuleMeta } from '@core/types';
import { makeLogger } from '@core/log';
import { getSpoofManager } from '@core/spoof-manager';
import { getJavaClass } from '@core/java-utils';
import { Java, performOnJava } from '@core/java-bridge';

const log = makeLogger('spoof-validator');

interface SpoofValidationResult {
  method: string;
  originalValue: any;
  spoofedValue: any;
  isChanged: boolean;
  timestamp: number;
}

interface ValidationReport {
  appPackage: string;
  testResults: SpoofValidationResult[];
  summary: {
    totalTests: number;
    successfulSpoofs: number;
    failedSpoofs: number;
    successRate: number;
  };
  timestamp: number;
}

function getClassWrapper(className: string): any {
  const classLoaders = Java.enumerateClassLoadersSync();
  for (const loader of classLoaders) {
    try {
      loader.findClass(className);
      return Java.ClassFactory.get(loader).use(className);
    } catch (e) {
      continue;
    }
  }
  throw new Error(`${className} not found`);
}

async function activate(ctx: Ctx) {
  const { cfg } = ctx;
  const spoofManager = getSpoofManager();
  
  // 检查是否启用了验证功能
  const validationEnabled = cfg.flags?.['validator.enabled'] === true;
  const detectAppValidation = cfg.flags?.['validator.detectApp'] === true;
  
  if (!validationEnabled) {
    log('Spoof validation disabled');
    return;
  }

  log('🎯 Spoof validation module activated');
  
  await performOnJava(() => {
    const validationResults: SpoofValidationResult[] = [];
    
    // 等待应用完全加载
    setTimeout(() => {
      try {
        runSpoofValidation();
      } catch (e) {
        log('✗ Validation failed: %s', e);
      }
    }, 3000);
    
    function runSpoofValidation() {
      log('🔍 Starting automated spoof validation...');
      
      // 获取Context
      const ActivityThread = getJavaClass('android.app.ActivityThread');
      const app = ActivityThread.currentApplication();
      
      if (!app) {
        log('⚠ Application context not available, retrying...');
        setTimeout(runSpoofValidation, 2000);
        return;
      }
      
      const context = app.getApplicationContext();
      log('✓ Context obtained: %s', context);
      
      // DetectApp 专用验证
      if (detectAppValidation) {
        validateDetectApp(context);
      }
      
      // 通用系统API验证
      validateSystemAPIs(context);
      
      // 生成验证报告
      setTimeout(() => {
        generateValidationReport();
      }, 2000);
    }
    
    function validateDetectApp(context: any) {
      log('🎯 Running DetectApp specific validation...');
      
      try {
        const SettingPropInfoCollect = getClassWrapper(
          'com.detect.app.sample.fingerprint_detect.unique_fingerprint.SettingPropInfoCollect'
        );
        
        log('✓ SettingPropInfoCollect class found');
        
        // 调用原始方法获取结果
        const result = SettingPropInfoCollect.getAllInfo(context);
        log('📊 DetectApp getAllInfo result: %s', result);
        
        // 解析结果并验证伪装效果
        try {
          const resultObj = JSON.parse(result.toString());
          validateDetectAppResult(resultObj);
        } catch (e) {
          log('📊 DetectApp getAllInfo result (raw): %s', result);
          validateDetectAppResultRaw(result.toString());
        }
        
      } catch (e) {
        log('⚠ DetectApp validation failed: %s', e);
      }
    }
    
    function validateDetectAppResult(resultObj: any) {
      log('🔍 Analyzing DetectApp result object...');
      
      const spoofConfig = spoofManager.getConfig('device_info');
      const simConfig = spoofManager.getConfig('sim_info');
      
      // 检查设备信息伪装
      if (spoofConfig) {
        checkSpoofResult('brand', resultObj.brand || resultObj.device_brand, spoofConfig.brand);
        checkSpoofResult('manufacturer', resultObj.manufacturer || resultObj.device_manufacturer, spoofConfig.manufacturer);
        checkSpoofResult('model', resultObj.model || resultObj.device_model, spoofConfig.model);
        checkSpoofResult('android_version', resultObj.android_version || resultObj.version, spoofConfig.android_version);
        checkSpoofResult('android_id', resultObj.android_id || resultObj.androidId, spoofConfig.android_id);
      }
      
      // 检查SIM信息伪装
      if (simConfig) {
        checkSpoofResult('simOperator', resultObj.sim_operator || resultObj.simOperator, simConfig.simOperator);
        checkSpoofResult('simOperatorName', resultObj.sim_operator_name || resultObj.simOperatorName, simConfig.simOperatorName);
        checkSpoofResult('imei', resultObj.imei, simConfig.imei);
        checkSpoofResult('line1Number', resultObj.phone_number || resultObj.line1Number, simConfig.line1Number);
      }
    }
    
    function validateDetectAppResultRaw(result: string) {
      log('🔍 Analyzing DetectApp raw result...');
      
      const spoofConfig = spoofManager.getConfig('device_info');
      const simConfig = spoofManager.getConfig('sim_info');
      
      // 简单的字符串匹配检查
      if (spoofConfig) {
        if (spoofConfig.brand && result.includes(spoofConfig.brand)) {
          log('✅ Brand spoofing detected in result: %s', spoofConfig.brand);
        }
        if (spoofConfig.model && result.includes(spoofConfig.model)) {
          log('✅ Model spoofing detected in result: %s', spoofConfig.model);
        }
        if (spoofConfig.android_id && result.includes(spoofConfig.android_id)) {
          log('✅ Android ID spoofing detected in result: %s', spoofConfig.android_id);
        }
      }
      
      if (simConfig) {
        if (simConfig.simOperator && result.includes(simConfig.simOperator)) {
          log('✅ SIM Operator spoofing detected in result: %s', simConfig.simOperator);
        }
        if (simConfig.simOperatorName && result.includes(simConfig.simOperatorName)) {
          log('✅ SIM Operator Name spoofing detected in result: %s', simConfig.simOperatorName);
        }
      }
    }
    
    function validateSystemAPIs(context: any) {
      log('🔍 Running system APIs validation...');
      
      try {
        // 验证TelephonyManager
        const telephonyService = context.getSystemService('phone');
        
        if (telephonyService) {
          const simOperator = telephonyService.getSimOperator();
          const simOperatorName = telephonyService.getSimOperatorName();
          
          const simConfig = spoofManager.getConfig('sim_info');
          if (simConfig) {
            checkSpoofResult('TelephonyManager.getSimOperator', simOperator, simConfig.simOperator);
            checkSpoofResult('TelephonyManager.getSimOperatorName', simOperatorName, simConfig.simOperatorName);
          }
        }
        
        // 验证Build信息
        const Build = getJavaClass('android.os.Build');
        const deviceConfig = spoofManager.getConfig('device_info');
        
        if (deviceConfig) {
          checkSpoofResult('Build.BRAND', Build.BRAND.value, deviceConfig.brand);
          checkSpoofResult('Build.MANUFACTURER', Build.MANUFACTURER.value, deviceConfig.manufacturer);
          checkSpoofResult('Build.MODEL', Build.MODEL.value, deviceConfig.model);
        }
        
        // 验证Settings
        const Settings = getJavaClass('android.provider.Settings$Secure');
        const androidId = Settings.getString(context.getContentResolver(), 'android_id');
        
        if (deviceConfig?.android_id) {
          checkSpoofResult('Settings.android_id', androidId, deviceConfig.android_id);
        }
        
      } catch (e) {
        log('⚠ System APIs validation failed: %s', e);
      }
    }
    
    function checkSpoofResult(methodName: string, actualValue: any, expectedValue: any) {
      const isChanged = actualValue === expectedValue;
      const result: SpoofValidationResult = {
        method: methodName,
        originalValue: actualValue,
        spoofedValue: expectedValue,
        isChanged,
        timestamp: Date.now()
      };
      
      validationResults.push(result);
      
      if (isChanged) {
        log('✅ %s: %s (spoofed successfully)', methodName, actualValue);
      } else {
        log('❌ %s: %s (spoofing failed, expected: %s)', methodName, actualValue, expectedValue);
      }
    }
    
    function generateValidationReport() {
      log('📊 Generating validation report...');
      
      const packageName = 'com.detect.app.sample'; // TODO: 动态获取包名
      const successfulSpoofs = validationResults.filter(r => r.isChanged).length;
      const failedSpoofs = validationResults.filter(r => !r.isChanged).length;
      
      const report: ValidationReport = {
        appPackage: packageName,
        testResults: validationResults,
        summary: {
          totalTests: validationResults.length,
          successfulSpoofs,
          failedSpoofs,
          successRate: validationResults.length > 0 ? (successfulSpoofs / validationResults.length) * 100 : 0
        },
        timestamp: Date.now()
      };
      
      // 发送报告到主机
      send({
        type: 'spoof-validation-report',
        data: report
      });
      
      // 打印摘要
      log('📈 VALIDATION SUMMARY:');
      log('   Total Tests: %d', report.summary.totalTests);
      log('   Successful Spoofs: %d', report.summary.successfulSpoofs);
      log('   Failed Spoofs: %d', report.summary.failedSpoofs);
      log('   Success Rate: %.1f%%', report.summary.successRate);
      
      if (report.summary.successRate >= 80) {
        log('🎉 Spoof validation PASSED (%.1f%% success rate)', report.summary.successRate);
      } else if (report.summary.successRate >= 50) {
        log('⚠ Spoof validation PARTIAL (%.1f%% success rate)', report.summary.successRate);
      } else {
        log('❌ Spoof validation FAILED (%.1f%% success rate)', report.summary.successRate);
      }
    }
  });
}

export const meta: ModuleMeta = {
  id: 'android/spoof-validator',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: ['validation', 'spoof', 'testing'],
  },
  priority: 3,
  activate,
};
