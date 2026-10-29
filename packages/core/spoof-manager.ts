import { makeLogger } from './log';
import { getJavaClass } from './java-utils';

const log = makeLogger('spoof-manager');

/**
 * 通用设备指纹伪装配置接口
 */
export interface DeviceSpoofConfig {
  // 设备基本信息
  device_info?: {
    brand?: string;
    manufacturer?: string;
    model?: string;
    device?: string;
    product?: string;
    hardware?: string;
    board?: string;
    serial?: string;
    android_id?: string;
    fingerprint?: string;
    bootloader?: string;
    build_id?: string;
    android_version?: string;
    api_level?: number;
    security_patch?: string;
  };

  // SIM卡信息
  sim_info?: {
    simOperator?: string;
    simOperatorName?: string;
    simCountryIso?: string;
    networkOperator?: string;
    networkOperatorName?: string;
    networkCountryIso?: string;
    simSerialNumber?: string;
    subscriberId?: string;
    line1Number?: string;
    carrierId?: number;
    specificCarrierId?: number;
    imei?: string;
    imsi?: string;
  };

  // 位置信息
  location_info?: {
    latitude?: number;
    longitude?: number;
    altitude?: number;
    accuracy?: number;
    provider?: string;
    country?: string;
    city?: string;
    timezone?: string;
  };

  // 网络信息
  network_info?: {
    wifi_ssid?: string;
    wifi_bssid?: string;
    wifi_mac?: string;
    cellular_type?: string;
    ip_address?: string;
    dns_servers?: string[];
  };

  // 硬件信息
  hardware_info?: {
    cpu_cores?: number;
    cpu_freq?: number;
    ram_total?: number;
    storage_total?: number;
    screen_width?: number;
    screen_height?: number;
    density_dpi?: number;
    battery_capacity?: number;
  };

  // 传感器信息
  sensor_info?: {
    accelerometer?: boolean;
    gyroscope?: boolean;
    magnetometer?: boolean;
    proximity?: boolean;
    light?: boolean;
    fingerprint?: boolean;
    face_unlock?: boolean;
  };
}

/**
 * 通用伪装管理器
 */
export class UniversalSpoofManager {
  private static instance: UniversalSpoofManager | null = null;
  private config: DeviceSpoofConfig | null = null;
  private configLoaded = false;
  private hookedMethods = new Set<any>();

  private constructor() {}

  /**
   * 获取单例实例
   */
  static getInstance(): UniversalSpoofManager {
    if (!UniversalSpoofManager.instance) {
      UniversalSpoofManager.instance = new UniversalSpoofManager();
    }
    return UniversalSpoofManager.instance;
  }

  /**
   * 加载伪装配置文件
   */
  loadConfig(): DeviceSpoofConfig | null {
    if (this.configLoaded) {
      return this.config;
    }

    try {
      const configPaths = [
        '/data/local/tmp/device_fingerprint.json',
        '/sdcard/device_fingerprint.json',
        '/storage/emulated/0/device_fingerprint.json',
        // 添加更多可能的路径
        '/data/local/tmp/spoof_config.json',
        '/sdcard/spoof_config.json',
      ];

      const File = getJavaClass('java.io.File', false);
      const FileInputStream = getJavaClass('java.io.FileInputStream', false);
      const BufferedReader = getJavaClass('java.io.BufferedReader', false);
      const InputStreamReader = getJavaClass('java.io.InputStreamReader', false);
      const StringBuilder = getJavaClass('java.lang.StringBuilder', false);

      if (!File || !FileInputStream || !BufferedReader || !InputStreamReader || !StringBuilder) {
        log('⚠ Java file I/O classes not available');
        this.configLoaded = true;
        return null;
      }

      for (const path of configPaths) {
        try {
          const file = File.$new(path);
          if (file.exists() && file.canRead()) {
            const fis = FileInputStream.$new(file);
            const isr = InputStreamReader.$new(fis, 'UTF-8');
            const reader = BufferedReader.$new(isr);
            const sb = StringBuilder.$new();

            let line = reader.readLine();
            while (line !== null) {
              sb.append(line).append('\n');
              line = reader.readLine();
            }

            reader.close();
            const jsonContent = sb.toString();
            const parsedConfig = JSON.parse(jsonContent);

            this.config = parsedConfig;
            this.configLoaded = true;
            log('✓ Spoof config loaded from: %s', path);
            return this.config;
          }
        } catch (e) {
          log('⚠ Failed to load config from %s: %s', path, e);
        }
      }

      log('⚠ No spoof config file found');
      this.configLoaded = true;
      return null;
    } catch (e) {
      log('✗ Config loading crashed: %s', e);
      this.configLoaded = true;
      return null;
    }
  }

  /**
   * 获取指定类型的伪装配置
   */
  getConfig<K extends keyof DeviceSpoofConfig>(type: K): DeviceSpoofConfig[K] | null {
    if (!this.config) {
      this.config = this.loadConfig();
    }
    return this.config?.[type] || null;
  }

  /**
   * 检查是否应该伪装指定的值
   */
  shouldSpoof(type: keyof DeviceSpoofConfig, field: string, enableFlag: boolean): boolean {
    if (!enableFlag) {
return false;
}
    
    const typeConfig = this.getConfig(type);
    return !!(typeConfig && (typeConfig as any)[field] !== undefined);
  }

  /**
   * 获取伪装后的值，确保类型安全
   */
  getSpoofValue<T>(
    type: keyof DeviceSpoofConfig, 
    field: string, 
    originalValue: T,
    targetType: 'string' | 'number' | 'boolean' = 'string'
  ): T {
    const typeConfig = this.getConfig(type);
    if (!typeConfig) {
return originalValue;
}

    const spoofValue = (typeConfig as any)[field];
    if (spoofValue === undefined) {
return originalValue;
}

    // 类型转换
    try {
      switch (targetType) {
        case 'string':
          return String(spoofValue) as T;
        case 'number':
          return Number(spoofValue) as T;
        case 'boolean':
          return Boolean(spoofValue) as T;
        default:
          return spoofValue as T;
      }
    } catch (e) {
      log('⚠ Type conversion failed for %s.%s: %s', type, field, e);
      return originalValue;
    }
  }

  /**
   * 通用的方法Hook助手
   */
  hookMethod(
    className: string,
    methodName: string,
    overloadSignature: string | null,
    type: keyof DeviceSpoofConfig,
    field: string,
    enableFlag: boolean,
    targetType: 'string' | 'number' | 'boolean' = 'string',
    logPrefix: string = '',
    strictMode: boolean = false
  ): boolean {
    try {
      const clazz = getJavaClass(className, false);
      if (!clazz) {
        if (strictMode) {
          throw new Error(`Class ${className} not found`);
        }
        log('⚠ Class %s not found', className);
        return false;
      }

      let methodRef: any;
      try {
        methodRef = overloadSignature
          ? clazz[methodName].overload(overloadSignature)
          : clazz[methodName].overload();
      } catch (e) {
        log(
          '⚠ Method %s.%s not available on this target%s: %s',
          className,
          methodName,
          strictMode ? ' (strict mode continues for compatibility gaps)' : '',
          e
        );
        return false;
      }

      if (!methodRef) {
        log(
          '⚠ Method %s.%s not available on this target%s',
          className,
          methodName,
          strictMode ? ' (strict mode continues for compatibility gaps)' : ''
        );
        return false;
      }

      const manager = this;
      methodRef.implementation = function(...args: any[]) {
        const originalResult = this[methodName](...args);
        
        if (manager.shouldSpoof(type, field, enableFlag)) {
          const spoofedResult = manager.getSpoofValue(type, field, originalResult, targetType);
          log('%s%s: %s -> %s (spoofed)', logPrefix, methodName, originalResult, spoofedResult);
          return spoofedResult;
        }

        log('%s%s: %s', logPrefix, methodName, originalResult);
        return originalResult;
      };

      this.hookedMethods.add(methodRef);
      return true;
    } catch (e) {
      if (strictMode) {
        throw e;
      }
      log('✗ Hook failed for %s.%s: %s', className, methodName, e);
      return false;
    }
  }

  /**
   * 批量Hook方法
   */
  hookMethods(hooks: Array<{
    className: string;
    methodName: string;
    overload?: string;
    type: keyof DeviceSpoofConfig;
    field: string;
    targetType?: 'string' | 'number' | 'boolean';
    logPrefix?: string;
  }>, enableFlag: boolean, strictMode: boolean = false): number {
    let successCount = 0;
    
    for (const hook of hooks) {
      const success = this.hookMethod(
        hook.className,
        hook.methodName,
        hook.overload || null,
        hook.type,
        hook.field,
        enableFlag,
        hook.targetType || 'string',
        hook.logPrefix || '',
        strictMode
      );
      
      if (success) {
successCount++;
}
    }
    
    log('Hooked %d/%d methods successfully', successCount, hooks.length);
    return successCount;
  }

  /**
   * 重置配置（用于测试）
   */
  resetConfig(): void {
    this.config = null;
    this.configLoaded = false;
  }

  /**
   * 卸载所有Hook（用于模块deactivate）
   */
  unhookAll(): void {
    if (this.hookedMethods.size === 0) {
      return;
    }
    let count = 0;
    for (const methodRef of this.hookedMethods) {
      try {
        methodRef.implementation = null;
        count++;
      } catch (e) {
        log('⚠ Failed to unhook method: %s', e);
      }
    }
    this.hookedMethods.clear();
    log('Unhooked %d methods', count);
  }
}

/**
 * 获取全局伪装管理器实例
 */
export function getSpoofManager(): UniversalSpoofManager {
  return UniversalSpoofManager.getInstance();
}
