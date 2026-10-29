#!/usr/bin/env python3
"""
Frida Spoof 自动化验证工具
用于验证设备伪装功能是否正常工作

用法:
    python test/frida_spoof_ci.py

功能:
1. 自动推送伪装配置
2. 启动应用并注入Hook  
3. 主动调用 SettingPropInfoCollect.getAllInfo()
4. 验证伪装效果
5. 生成验证报告
"""

import subprocess
import time
import json
import sys
import os
from datetime import datetime

# 配置
APP_PACKAGE = "com.detect.app.sample"
CONFIG_FILE = "configs/targets/detect-app-sample.json"
SPOOF_CONFIG = "examples/detect-app-spoof-demo.json"

class SpoofValidator:
    def __init__(self):
        self.results = []
        self.start_time = datetime.now()
        
    def log(self, message, level="INFO"):
        timestamp = datetime.now().strftime("%H:%M:%S")
        print(f"[{timestamp}] {level}: {message}")
        
    def run_command(self, cmd, capture_output=True):
        """运行命令并返回结果"""
        try:
            if isinstance(cmd, str):
                cmd = cmd.split()
            result = subprocess.run(cmd, capture_output=capture_output, text=True, check=True)
            return result.stdout.strip()
        except subprocess.CalledProcessError as e:
            self.log(f"命令失败: {' '.join(cmd)}", "ERROR")
            self.log(f"错误: {e.stderr}", "ERROR")
            return None
            
    def check_prerequisites(self):
        """检查前提条件"""
        self.log("检查前提条件...")
        
        # 检查设备连接
        devices = self.run_command("adb devices")
        if not devices or "device" not in devices:
            self.log("没有连接的设备", "ERROR")
            return False
            
        # 检查应用安装
        packages = self.run_command(f"adb shell pm list packages {APP_PACKAGE}")
        if not packages or APP_PACKAGE not in packages:
            self.log(f"应用 {APP_PACKAGE} 未安装", "ERROR")
            return False
            
        self.log("✅ 前提条件检查通过")
        return True
        
    def push_spoof_config(self):
        """推送伪装配置到设备"""
        self.log("推送伪装配置...")
        
        if not os.path.exists(SPOOF_CONFIG):
            self.log(f"配置文件 {SPOOF_CONFIG} 不存在", "ERROR")
            return False
            
        # 推送配置文件
        result = self.run_command(f"adb push {SPOOF_CONFIG} /data/local/tmp/device_fingerprint.json")
        if result is None:
            return False
            
        self.log("✅ 伪装配置已推送")
        return True
        
    def create_validation_script(self):
        """创建验证用的Frida脚本"""
        script_content = '''
console.log("[VALIDATOR] Starting spoof validation...");

setTimeout(function() {
    Java.perform(function() {
        console.log("[VALIDATOR] Java environment ready");
        
        try {
            // 获取Context
            var ActivityThread = Java.use("android.app.ActivityThread");
            var app = ActivityThread.currentApplication();
            
            if (!app) {
                console.log("[VALIDATOR] ❌ Application context not available");
                return;
            }
            
            var context = app.getApplicationContext();
            console.log("[VALIDATOR] ✅ Context obtained: " + context);
            
            // 尝试加载DetectApp的类
            try {
                console.log("[VALIDATOR] 🔍 Loading DetectApp class...");
                
                // 枚举ClassLoader寻找目标类
                var className = "com.detect.app.sample.fingerprint_detect.unique_fingerprint.SettingPropInfoCollect";
                var targetClass = null;
                
                Java.enumerateClassLoaders({
                    onMatch: function(loader) {
                        try {
                            targetClass = Java.ClassFactory.get(loader).use(className);
                            console.log("[VALIDATOR] ✅ Found SettingPropInfoCollect class");
                            return "stop";
                        } catch (e) {
                            // 继续寻找
                        }
                    },
                    onComplete: function() {}
                });
                
                if (targetClass) {
                    console.log("[VALIDATOR] 🎯 Calling getAllInfo()...");
                    var result = targetClass.getAllInfo(context);
                    console.log("[VALIDATOR] 📊 DetectApp Result: " + result);
                    
                    // 验证伪装效果
                    validateSpoofResult(result.toString());
                } else {
                    console.log("[VALIDATOR] ⚠ SettingPropInfoCollect class not found");
                }
                
            } catch (e) {
                console.log("[VALIDATOR] ❌ DetectApp validation error: " + e);
            }
            
            // 验证系统API
            validateSystemAPIs(context);
            
        } catch (e) {
            console.log("[VALIDATOR] ❌ Validation failed: " + e);
        }
        
    });
}, 3000);

function validateSpoofResult(result) {
    console.log("[VALIDATOR] 🔍 Analyzing result for spoof indicators...");
    
    var spoofCount = 0;
    var totalChecks = 0;
    
    // 检查预期的伪装值
    var expectedValues = {
        "samsung": "Brand spoofing",
        "SM-G998B": "Model spoofing", 
        "T-Mobile": "SIM Operator spoofing",
        "31000": "SIM Operator code spoofing",
        "1234567890abcdef": "Android ID spoofing"
    };
    
    for (var value in expectedValues) {
        totalChecks++;
        if (result.includes(value)) {
            spoofCount++;
            console.log("[VALIDATOR] ✅ " + expectedValues[value] + " detected: " + value);
        } else {
            console.log("[VALIDATOR] ❌ " + expectedValues[value] + " not found: " + value);
        }
    }
    
    var successRate = (spoofCount / totalChecks) * 100;
    console.log("[VALIDATOR] 📈 Spoof Success Rate: " + successRate.toFixed(1) + "% (" + spoofCount + "/" + totalChecks + ")");
    
    if (successRate >= 80) {
        console.log("[VALIDATOR] 🎉 VALIDATION PASSED");
    } else if (successRate >= 50) {
        console.log("[VALIDATOR] ⚠ VALIDATION PARTIAL");
    } else {
        console.log("[VALIDATOR] ❌ VALIDATION FAILED");
    }
}

function validateSystemAPIs(context) {
    console.log("[VALIDATOR] 🔍 Validating system APIs...");
    
    try {
        // TelephonyManager
        var telephonyService = context.getSystemService("phone");
        if (telephonyService) {
            try {
                var simOperator = telephonyService.getSimOperator();
                var simOperatorName = telephonyService.getSimOperatorName();
                console.log("[VALIDATOR] 📞 SIM Operator: " + simOperator + " (" + simOperatorName + ")");
            } catch (e) {
                console.log("[VALIDATOR] ⚠ TelephonyManager access failed: " + e);
            }
        }
        
        // Build info
        var Build = Java.use("android.os.Build");
        console.log("[VALIDATOR] 🏭 Build.BRAND: " + Build.BRAND.value);
        console.log("[VALIDATOR] 🏭 Build.MODEL: " + Build.MODEL.value);
        
        // Settings
        var Settings = Java.use("android.provider.Settings$Secure");
        var androidId = Settings.getString(context.getContentResolver(), "android_id");
        console.log("[VALIDATOR] 🔐 Android ID: " + androidId);
        
    } catch (e) {
        console.log("[VALIDATOR] ❌ System API validation error: " + e);
    }
    
    console.log("[VALIDATOR] 🏁 Validation completed");
}
'''
        
        with open("temp_validation.js", "w", encoding="utf-8") as f:
            f.write(script_content)
            
        return "temp_validation.js"
        
    def run_validation(self):
        """运行验证测试"""
        self.log("开始伪装验证...")
        
        # 创建验证脚本
        script_file = self.create_validation_script()
        
        try:
            # 启动应用并注入验证脚本
            cmd = f"frida -U -f {APP_PACKAGE} -l {script_file} --no-pause"
            self.log(f"执行: {cmd}")
            
            # 使用subprocess.Popen来实时获取输出
            process = subprocess.Popen(
                cmd.split(),
                stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT,
                text=True,
                universal_newlines=True
            )
            
            validation_output = []
            start_time = time.time()
            timeout = 15  # 15秒超时
            
            while True:
                if time.time() - start_time > timeout:
                    self.log("验证超时，结束进程")
                    process.terminate()
                    break
                    
                line = process.stdout.readline()
                if not line and process.poll() is not None:
                    break
                    
                if line:
                    line = line.strip()
                    validation_output.append(line)
                    
                    # 实时显示重要输出
                    if any(keyword in line for keyword in [
                        "[VALIDATOR]", "spoofed", "✅", "❌", "🎉", "⚠"
                    ]):
                        print(line)
                        
            return validation_output
            
        except Exception as e:
            self.log(f"验证执行失败: {e}", "ERROR")
            return []
            
        finally:
            # 清理临时文件
            if os.path.exists(script_file):
                os.remove(script_file)
                
    def analyze_results(self, output):
        """分析验证结果"""
        self.log("分析验证结果...")
        
        spoof_indicators = [
            ("Brand spoofing", "samsung"),
            ("Model spoofing", "SM-G998B"),
            ("SIM Operator spoofing", "T-Mobile"),
            ("Android ID spoofing", "1234567890abcdef")
        ]
        
        found_spoofs = []
        total_output = "\n".join(output)
        
        for description, indicator in spoof_indicators:
            if indicator in total_output:
                found_spoofs.append(description)
                self.log(f"✅ {description} detected")
            else:
                self.log(f"❌ {description} not found")
                
        success_rate = (len(found_spoofs) / len(spoof_indicators)) * 100
        
        # 生成报告
        report = {
            "timestamp": self.start_time.isoformat(),
            "app_package": APP_PACKAGE,
            "total_checks": len(spoof_indicators),
            "successful_spoofs": len(found_spoofs),
            "success_rate": success_rate,
            "found_spoofs": found_spoofs,
            "validation_output": output[-50:]  # 保留最后50行输出
        }
        
        # 保存报告
        with open("output/spoof_validation_report.json", "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
            
        self.log(f"📊 验证完成: {success_rate:.1f}% 成功率 ({len(found_spoofs)}/{len(spoof_indicators)})")
        
        return success_rate >= 60  # 60%以上算通过
        
    def run(self):
        """运行完整验证流程"""
        self.log("🎯 开始 Frida Spoof 自动化验证")
        
        try:
            # 1. 检查前提条件
            if not self.check_prerequisites():
                return False
                
            # 2. 推送配置
            if not self.push_spoof_config():
                return False
                
            # 3. 等待一下确保配置生效
            self.log("等待配置生效...")
            time.sleep(2)
            
            # 4. 运行验证
            output = self.run_validation()
            
            # 5. 分析结果
            passed = self.analyze_results(output)
            
            if passed:
                self.log("🎉 验证通过！伪装功能正常工作")
            else:
                self.log("⚠ 验证未完全通过，请检查配置和权限")
                
            return passed
            
        except Exception as e:
            self.log(f"验证过程出错: {e}", "ERROR")
            return False

def main():
    """主函数"""
    print("""
🎭 Frida Spoof 自动化验证工具
================================

此工具将自动验证 DetectApp Sample 的设备伪装效果
包括 SIM 信息、设备信息、Android ID 等的伪装

前提条件:
- DetectApp 应用已安装
- 设备已连接并启用 USB 调试
- Frida 服务正在运行
""")
    
    validator = SpoofValidator()
    success = validator.run()
    
    if success:
        print("\n✅ 验证成功完成！")
        sys.exit(0)
    else:
        print("\n❌ 验证失败或未完全通过")
        sys.exit(1)

if __name__ == "__main__":
    main()