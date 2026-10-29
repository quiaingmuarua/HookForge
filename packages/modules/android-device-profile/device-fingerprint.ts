import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';
import { getJavaClass } from '@core/java-utils';
import { Java, performOnJava } from '@core/java-bridge';
import { emitTraceEvent } from '@events/sink';

interface DeviceFingerprint {
  device_info: {
    brand: string;
    manufacturer: string;
    model: string;
    device: string;
    product: string;
    hardware: string;
    board: string;
    fingerprint: string;
    bootloader: string;
    radio?: string;
    build_id: string;
    tags: string;
    type: string;

    android_version: string;
    api_level: number;
    security_patch: string;
    kernel_version?: string;
    uptime?: number;

    screen_width: number;
    screen_height: number;
    density_dpi: number;
    refresh_rate?: number;

    language: string;
    country: string;
    locale: string;
    timezone: string;

    android_id: string;
    google_ad_id?: string;
    serial?: string;
    mac_address?: string;
    bluetooth_address?: string;

    cpu_cores: number;
    cpu_max_freq?: number;
    ram_total: number;
    storage_total?: number;
    battery_capacity?: number;
    sensors: string[];
  };

  sim_info: {
    iccId?: string;
    phoneNumber?: string;
    carrierId?: string;
    simOperator?: string;
    subscriberId?: string;
    simOperatorName?: string;
    simCountryIso?: string;
    mcc?: string;
    mnc?: string;
    simCountryIsoCode?: string;

    imei?: string;
    meid?: string;
    imsi?: string;
    networkOperator?: string;
    networkOperatorName?: string;
    networkCountryIso?: string;
    networkType?: string;
    isRoaming?: boolean;
  };

  collection_info: {
    timestamp: number;
    collection_date: string;
    frida_version?: string;
    collection_method: string;
  };
}

/**
 * Android 设备指纹收集器
 * 收集全面的设备信息和SIM卡信息，用于设备指纹分析
 */
class DeviceFingerprintCollector {
  private moduleLog: (_msg: string, ..._args: any[]) => void;
  private fingerprint: DeviceFingerprint;

  constructor(moduleLog: (_msg: string, ..._args: any[]) => void) {
    this.moduleLog = moduleLog;
    this.fingerprint = {
      device_info: {
        brand: '',
        manufacturer: '',
        model: '',
        device: '',
        product: '',
        hardware: '',
        board: '',
        fingerprint: '',
        bootloader: '',
        build_id: '',
        tags: '',
        type: '',
        android_version: '',
        api_level: 0,
        security_patch: '',
        screen_width: 0,
        screen_height: 0,
        density_dpi: 0,
        language: '',
        country: '',
        locale: '',
        timezone: '',
        android_id: '',
        cpu_cores: 0,
        ram_total: 0,
        sensors: [],
      },
      sim_info: {},
      collection_info: {
        timestamp: Date.now(),
        collection_date: new Date().toISOString(),
        collection_method: 'frida-hook',
      },
    };
  }

  private mergeSimField<K extends keyof DeviceFingerprint['sim_info']>(
    key: K,
    value: DeviceFingerprint['sim_info'][K]
  ) {
    if (value === undefined || value === null || value === '') {
      return;
    }

    if (typeof value === 'string') {
      const normalizedValue = value.trim();
      if (!normalizedValue || /^[,\s]+$/.test(normalizedValue)) {
        return;
      }
      value = normalizedValue as DeviceFingerprint['sim_info'][K];
    }

    const currentValue = this.fingerprint.sim_info[key];
    if (currentValue === undefined || currentValue === null || currentValue === '') {
      this.fingerprint.sim_info[key] = value;
    }
  }

  /**
   * 收集设备基本信息
   */
  collectDeviceInfo() {
    try {
      const Build = getJavaClass('android.os.Build', true);
      const BuildVersion = getJavaClass('android.os.Build$VERSION', true);

      // 基本设备信息
      this.fingerprint.device_info.brand = Build.BRAND.value || '';
      this.fingerprint.device_info.manufacturer = Build.MANUFACTURER.value || '';
      this.fingerprint.device_info.model = Build.MODEL.value || '';
      this.fingerprint.device_info.device = Build.DEVICE.value || '';
      this.fingerprint.device_info.product = Build.PRODUCT.value || '';
      this.fingerprint.device_info.hardware = Build.HARDWARE.value || '';
      this.fingerprint.device_info.board = Build.BOARD.value || '';
      this.fingerprint.device_info.fingerprint = Build.FINGERPRINT.value || '';
      this.fingerprint.device_info.bootloader = Build.BOOTLOADER.value || '';
      this.fingerprint.device_info.build_id = Build.ID.value || '';
      this.fingerprint.device_info.tags = Build.TAGS.value || '';
      this.fingerprint.device_info.type = Build.TYPE.value || '';

      // Android版本信息
      this.fingerprint.device_info.android_version = BuildVersion.RELEASE.value || '';
      this.fingerprint.device_info.api_level = BuildVersion.SDK_INT.value || 0;

      try {
        this.fingerprint.device_info.security_patch = BuildVersion.SECURITY_PATCH.value || '';
      } catch (e) {
        // SECURITY_PATCH might not be available on older versions
      }

      // Radio版本
      try {
        const radio = Build.getRadioVersion();
        if (radio) {
          this.fingerprint.device_info.radio = radio.toString();
        }
      } catch (e) {
        // Radio version might not be available
      }

      this.moduleLog('✓ Device basic info collected');
    } catch (e) {
      this.moduleLog('✗ Failed to collect device info: %s', e);
    }
  }

  /**
   * 收集屏幕和显示信息
   */
  collectDisplayInfo() {
    try {
      const context = this.getCurrentContext();
      if (!context) {
        this.moduleLog('✗ Cannot collect display info: no context available');
        return;
      }

      this.moduleLog('🔍 Collecting display information...');

      // 方法1: 通过WindowManager
      let display: any = null;
      try {
        const WindowManager = getJavaClass('android.view.WindowManager', true);
        const DisplayMetrics = getJavaClass('android.util.DisplayMetrics', true);
        const windowManager = Java.cast(context.getSystemService('window'), WindowManager);
        if (windowManager) {
          display = windowManager.getDefaultDisplay();
          if (display) {
            const metrics = DisplayMetrics.$new();
            display.getMetrics(metrics);

            this.fingerprint.device_info.screen_width = metrics.widthPixels?.value || 0;
            this.fingerprint.device_info.screen_height = metrics.heightPixels?.value || 0;
            this.fingerprint.device_info.density_dpi = metrics.densityDpi?.value || 0;

            this.moduleLog(
              '✓ Display info via WindowManager - %dx%d @%ddpi',
              this.fingerprint.device_info.screen_width,
              this.fingerprint.device_info.screen_height,
              this.fingerprint.device_info.density_dpi
            );

            // 尝试获取刷新率 (Android 11+)
            try {
              const refreshRate = display.getRefreshRate();
              this.fingerprint.device_info.refresh_rate = Math.round(refreshRate);
            } catch (e) {
              // Refresh rate might not be available
            }
          }
        }
      } catch (e1) {
        this.moduleLog('⚠ WindowManager method failed: %s', e1);
      }

      // 方法2: 如果上面失败，尝试通过系统属性获取
      if (this.fingerprint.device_info.screen_width === 0) {
        try {
          // 注意：系统属性fallback方法需要进一步实现
          this.moduleLog('⚠ Display info not available, system properties fallback not implemented');
        } catch (e2) {
          this.moduleLog('⚠ System properties fallback failed: %s', e2);
        }
      }

      this.moduleLog(
        '✓ Display info collected: %dx%d @%ddpi',
        this.fingerprint.device_info.screen_width,
        this.fingerprint.device_info.screen_height,
        this.fingerprint.device_info.density_dpi
      );
    } catch (e) {
      this.moduleLog('✗ Failed to collect display info: %s', e);
    }
  }

  /**
   * 收集语言和地区信息
   */
  collectLocaleInfo() {
    try {
      const Locale = getJavaClass('java.util.Locale', true);
      const defaultLocale = Locale.getDefault();

      this.fingerprint.device_info.language = defaultLocale.getLanguage() || '';
      this.fingerprint.device_info.country = defaultLocale.getCountry() || '';
      this.fingerprint.device_info.locale = defaultLocale.toString() || '';

      // 获取时区
      try {
        const TimeZone = getJavaClass('java.util.TimeZone', true);
        const timeZone = TimeZone.getDefault();
        this.fingerprint.device_info.timezone = timeZone.getID() || '';
      } catch (e) {
        // TimeZone might not be available
      }

      this.moduleLog(
        '✓ Locale info collected: %s-%s (%s)',
        this.fingerprint.device_info.language,
        this.fingerprint.device_info.country,
        this.fingerprint.device_info.timezone
      );
    } catch (e) {
      this.moduleLog('✗ Failed to collect locale info: %s', e);
    }
  }

  /**
   * 收集设备标识符
   */
  collectDeviceIdentifiers() {
    try {
      const context = this.getCurrentContext();
      if (!context) {
        return;
      }

      // Android ID
      try {
        const Settings = getJavaClass('android.provider.Settings$Secure', true);
        const androidId = Settings.getString(context.getContentResolver(), 'android_id');
        this.fingerprint.device_info.android_id = androidId || '';
      } catch (e) {
        this.moduleLog('✗ Failed to get Android ID: %s', e);
      }

      // Google Advertising ID (需要异步获取)
      try {
        this.collectGoogleAdId(context);
      } catch (e) {
        // Google Ad ID might not be available
      }

      // Serial Number
      try {
        const Build = getJavaClass('android.os.Build', true);
        this.fingerprint.device_info.serial = Build.SERIAL.value || '';
      } catch (e) {
        // Serial might not be available due to permissions
      }

      this.moduleLog('✓ Device identifiers collected');
    } catch (e) {
      this.moduleLog('✗ Failed to collect device identifiers: %s', e);
    }
  }

  /**
   * 收集硬件信息
   */
  collectHardwareInfo() {
    try {
      // CPU核心数
      try {
        const Runtime = getJavaClass('java.lang.Runtime', true);
        const runtime = Runtime.getRuntime();
        this.fingerprint.device_info.cpu_cores = runtime.availableProcessors();
      } catch (e) {
        // Fallback method
        this.fingerprint.device_info.cpu_cores = 1;
      }

      // 内存信息
      try {
        const context = this.getCurrentContext();
        if (context) {
          const activityManager = context.getSystemService('activity');
          const MemoryInfo = getJavaClass('android.app.ActivityManager$MemoryInfo', true);
          const memInfo = MemoryInfo.$new();
          activityManager.getMemoryInfo(memInfo);

          // 转换为MB
          this.fingerprint.device_info.ram_total = Math.round(
            memInfo.totalMem.value / (1024 * 1024)
          );
        }
      } catch (e) {
        // Memory info might not be available
      }

      // 传感器信息
      try {
        this.collectSensorInfo();
      } catch (e) {
        this.moduleLog('✗ Failed to collect sensor info: %s', e);
      }

      this.moduleLog(
        '✓ Hardware info collected: %d cores, %dMB RAM',
        this.fingerprint.device_info.cpu_cores,
        this.fingerprint.device_info.ram_total
      );
    } catch (e) {
      this.moduleLog('✗ Failed to collect hardware info: %s', e);
    }
  }

  /**
   * 收集传感器信息
   */
  collectSensorInfo() {
    try {
      const context = this.getCurrentContext();
      if (!context) {
        return;
      }

      const sensorManager = context.getSystemService('sensor');
      const sensorList = sensorManager.getSensorList(-1); // -1 = TYPE_ALL

      const sensors: string[] = [];
      const sensorTypes: { [key: number]: string } = {
        1: 'accelerometer',
        2: 'magnetometer',
        4: 'gyroscope',
        5: 'light',
        6: 'pressure',
        8: 'proximity',
        9: 'gravity',
        10: 'linear_acceleration',
        11: 'rotation_vector',
        12: 'humidity',
        13: 'ambient_temperature',
      };

      for (let i = 0; i < sensorList.size(); i++) {
        const sensor = sensorList.get(i);
        const sensorType = sensor.getType();
        const sensorName = sensorTypes[sensorType] || `unknown_${sensorType}`;
        if (!sensors.includes(sensorName)) {
          sensors.push(sensorName);
        }
      }

      this.fingerprint.device_info.sensors = sensors.sort();
    } catch (e) {
      // Sensor info might not be available
    }
  }

  /**
   * 收集SIM卡信息
   */
  collectSimInfo() {
    // 方法1: 通过Context和TelephonyManager
    const context = this.getCurrentContext();
    let telephonyManager = null;

    if (context) {
      this.moduleLog('🔍 Attempting to get TelephonyManager service via Context...');
      try {
        telephonyManager = context.getSystemService('phone');
        if (telephonyManager) {
          this.moduleLog('✓ TelephonyManager service obtained via Context');
          this.collectSimInfoViaTelephonyManager(telephonyManager);
        }
      } catch (e) {
        this.moduleLog('⚠ TelephonyManager via Context failed: %s', e);
      }
    }

    // 方法2: 直接通过Java反射获取TelephonyManager
    if (!telephonyManager) {
      this.moduleLog('🔍 Attempting to get TelephonyManager via reflection...');
      try {
        const TelephonyManagerClass = getJavaClass('android.telephony.TelephonyManager', true);
        // 有些设备可能可以直接获取默认实例
        telephonyManager = TelephonyManagerClass.getDefault?.();
        if (telephonyManager) {
          this.moduleLog('✓ TelephonyManager obtained via reflection');
          this.collectSimInfoViaTelephonyManager(telephonyManager);
        }
      } catch (e) {
        this.moduleLog('⚠ TelephonyManager via reflection failed: %s', e);
      }
    }

    // 方法3: 通过系统属性获取基本信息
    this.collectSimInfoViaSystemProperties();

    if (!telephonyManager) {
      this.moduleLog('✗ All TelephonyManager acquisition methods failed');
    }
  }

  /**
   * 通过TelephonyManager收集SIM信息
   */
  private collectSimInfoViaTelephonyManager(telephonyManager: any) {
    const TelephonyManager = getJavaClass('android.telephony.TelephonyManager', true);
    const telephony = Java.cast(telephonyManager, TelephonyManager);
    try {
      // 基本SIM信息
      try {
        this.moduleLog('🔍 Collecting basic SIM information...');

        this.fingerprint.sim_info.simOperator = telephony.getSimOperator()?.toString() || '';
        this.fingerprint.sim_info.simOperatorName =
          telephony.getSimOperatorName()?.toString() || '';
        this.fingerprint.sim_info.simCountryIso =
          telephony.getSimCountryIso()?.toString() || '';
        this.fingerprint.sim_info.networkOperator =
          telephony.getNetworkOperator()?.toString() || '';
        this.fingerprint.sim_info.networkOperatorName =
          telephony.getNetworkOperatorName()?.toString() || '';
        this.fingerprint.sim_info.networkCountryIso =
          telephony.getNetworkCountryIso()?.toString() || '';

        try {
          this.fingerprint.sim_info.isRoaming = telephony.isNetworkRoaming();
        } catch (e) {
          this.moduleLog('⚠ Roaming status not available: %s', e);
        }

        // 解析MCC/MNC
        const simOperator = this.fingerprint.sim_info.simOperator || '';
        if (simOperator.length >= 5) {
          this.fingerprint.sim_info.mcc = simOperator.substring(0, 3);
          this.fingerprint.sim_info.mnc = simOperator.substring(3);
        }

        this.moduleLog(
          '✓ Basic SIM info collected - Operator: %s',
          this.fingerprint.sim_info.simOperatorName || 'Unknown'
        );
      } catch (e) {
        this.moduleLog('✗ Failed to get basic SIM info: %s', e);
      }

      // 敏感信息（需要权限）
      this.moduleLog(
        '🔍 Attempting to collect sensitive SIM information (may require permissions)...'
      );
      try {
        this.fingerprint.sim_info.imei = telephony.getDeviceId()?.toString() || '';
        this.moduleLog('✓ IMEI obtained');
      } catch (e) {
        this.moduleLog('⚠ IMEI requires READ_PHONE_STATE permission: %s', e);
      }

      try {
        this.fingerprint.sim_info.subscriberId =
          telephony.getSubscriberId()?.toString() || '';
        this.moduleLog('✓ Subscriber ID obtained');
      } catch (e) {
        this.moduleLog('⚠ Subscriber ID requires permission: %s', e);
      }

      try {
        this.fingerprint.sim_info.phoneNumber = telephony.getLine1Number()?.toString() || '';
        this.moduleLog('✓ Phone number obtained');
      } catch (e) {
        this.moduleLog('⚠ Phone number requires permission: %s', e);
      }

      // ICCID (SIM卡序列号)
      try {
        this.fingerprint.sim_info.iccId = telephony.getSimSerialNumber()?.toString() || '';
        this.moduleLog('✓ SIM serial number obtained');
      } catch (e) {
        this.moduleLog('⚠ SIM serial number requires permission: %s', e);
      }

      // 汇总SIM信息收集结果
      const operatorName = this.fingerprint.sim_info.simOperatorName || 'Unknown';
      const countryIso = this.fingerprint.sim_info.simCountryIso || 'Unknown';
      const hasBasicInfo =
        this.fingerprint.sim_info.simOperator || this.fingerprint.sim_info.simOperatorName;

      if (hasBasicInfo) {
        this.moduleLog(
          '✓ SIM info collected via TelephonyManager: %s (%s)',
          operatorName,
          countryIso
        );
        emitTraceEvent({
          ts: Date.now(),
          source: 'module',
          module: 'android/device-fingerprint',
          point: 'sim-telephony',
          kind: 'probe',
          phase: 'instant',
          attrs: {
            simOperator: this.fingerprint.sim_info.simOperator || '',
            simOperatorName: this.fingerprint.sim_info.simOperatorName || '',
            simCountryIso: this.fingerprint.sim_info.simCountryIso || '',
            source: 'telephony',
          },
        });
      } else {
        this.moduleLog('⚠ SIM info collection via TelephonyManager incomplete');
      }
    } catch (e) {
      this.moduleLog('✗ Failed to collect SIM info via TelephonyManager: %s', e);
    }
  }

  /**
   * 通过系统属性收集SIM信息
   */
  private collectSimInfoViaSystemProperties() {
    try {
      this.moduleLog('🔍 Attempting to collect SIM info via system properties...');

      const SystemProperties = getJavaClass('android.os.SystemProperties', true);

      // 运营商信息
      const operator = SystemProperties.get('gsm.operator.alpha', '');
      const operatorNumeric = SystemProperties.get('gsm.operator.numeric', '');
      const isoCountry = SystemProperties.get('gsm.operator.iso-country', '');

      this.mergeSimField('simOperatorName', operator?.toString());

      {
        this.mergeSimField('simOperator', operatorNumeric?.toString());
        // 解析MCC/MNC
        const currentOperator = this.fingerprint.sim_info.simOperator || '';
        if (currentOperator.length >= 5) {
          this.mergeSimField('mcc', currentOperator.substring(0, 3));
          this.mergeSimField('mnc', currentOperator.substring(3));
        }
      }

      this.mergeSimField('simCountryIso', isoCountry?.toString());

      // 网络类型信息
      const networkType = SystemProperties.get('gsm.network.type', '');
      this.mergeSimField('networkType', networkType?.toString());

      const hasPropsInfo = operator || operatorNumeric || isoCountry;
      if (hasPropsInfo) {
        this.moduleLog(
          '✓ SIM info collected via system properties: %s (%s)',
          operator || 'Unknown',
          isoCountry || 'Unknown'
        );
        emitTraceEvent({
          ts: Date.now(),
          source: 'module',
          module: 'android/device-fingerprint',
          point: 'sim-fallback',
          kind: 'probe',
          phase: 'instant',
          attrs: {
            operator: operator?.toString() || '',
            operatorNumeric: operatorNumeric?.toString() || '',
            isoCountry: isoCountry?.toString() || '',
            mergedSimOperator: this.fingerprint.sim_info.simOperator || '',
            mergedSimCountryIso: this.fingerprint.sim_info.simCountryIso || '',
            source: 'system-properties',
          },
        });
      } else {
        this.moduleLog('⚠ No SIM info available via system properties');
      }
    } catch (e) {
      this.moduleLog('✗ Failed to collect SIM info via system properties: %s', e);
    }
  }

  /**
   * 异步收集Google广告ID
   */
  collectGoogleAdId(_context: any) {
    try {
      // 这需要Google Play Services
      // 注意：这是异步操作，实际实现中需要回调处理
      // 这里只是示例结构
      getJavaClass('com.google.android.gms.ads.identifier.AdvertisingIdClient');
    } catch (e) {
      // Google Play Services not available
    }
  }

  /**
   * 获取当前应用上下文
   */
  getCurrentContext(): any {
    try {
      // 方法1: 通过ActivityThread获取
      try {
        const ActivityThread = getJavaClass('android.app.ActivityThread', true);
        const currentApplication = ActivityThread.currentApplication();
        if (currentApplication) {
          const context = currentApplication.getApplicationContext();
          if (context) {
            this.moduleLog('✓ Context obtained via ActivityThread');
            return context;
          }
        }
      } catch (e1) {
        this.moduleLog('⚠ Method 1 failed: %s', e1);
      }

      // 方法2: 尝试通过直接Java.use获取
      try {
        const ActivityThread = getJavaClass('android.app.ActivityThread', true);
        const currentApplication = ActivityThread.currentApplication();
        if (currentApplication) {
          const context = currentApplication.getApplicationContext();
          if (context) {
            this.moduleLog('✓ Context obtained via direct Java.use');
            return context;
          }
        }
      } catch (e2) {
        this.moduleLog('⚠ Method 2 failed: %s', e2);
      }

      // 方法3: 预留for未来的系统Context获取方法

      this.moduleLog('✗ All context acquisition methods failed');
      return null;
    } catch (e) {
      this.moduleLog('✗ Context acquisition crashed: %s', e);
      return null;
    }
  }

  /**
   * 收集所有设备指纹信息
   */
  collectAll(): DeviceFingerprint {
    this.moduleLog('🔍 Starting comprehensive device fingerprint collection...');

    // 收集基本设备信息
    this.collectDeviceInfo();
    this.collectLocaleInfo();
    this.collectDeviceIdentifiers();

    // 尝试收集其他信息，失败也无妨
    try {
      this.collectDisplayInfo();
    } catch (e) {
      this.moduleLog('⚠ Display info collection failed, continuing...');
    }

    try {
      this.collectHardwareInfo();
    } catch (e) {
      this.moduleLog('⚠ Hardware info collection failed, continuing...');
    }

    try {
      this.collectSimInfo();
    } catch (e) {
      this.moduleLog('⚠ SIM info collection failed, continuing...');
    }

    // 添加系统运行时间
    try {
      const SystemClock = getJavaClass('android.os.SystemClock', true);
      this.fingerprint.device_info.uptime = Math.floor(SystemClock.elapsedRealtime() / 1000);
    } catch (e) {
      // Uptime might not be available
    }

    this.moduleLog('✅ Device fingerprint collection completed');

    // 发送完成信号，让host知道可以退出了
    setTimeout(() => {
      send({ type: 'collection_complete', data: this.fingerprint });
    }, 1000);

    emitTraceEvent({
      ts: Date.now(),
      source: 'module',
      module: 'android/device-fingerprint',
      point: 'collection-complete',
      kind: 'validate',
      phase: 'instant',
      attrs: {
        brand: this.fingerprint.device_info.brand,
        model: this.fingerprint.device_info.model,
        simOperator: this.fingerprint.sim_info.simOperator || '',
        simCountryIso: this.fingerprint.sim_info.simCountryIso || '',
      },
    });

    return this.fingerprint;
  }

  /**
   * 将指纹数据保存为JSON文件
   */
  saveToFile(fingerprint: DeviceFingerprint, filename?: string) {
    try {
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const fileName = filename || `device_fingerprint_${timestamp}.json`;
      const filePath = `output/${fileName}`;

      const jsonData = JSON.stringify(fingerprint, null, 2);

      // 发送数据到主机端保存文件
      send({
        type: 'save_file',
        path: filePath,
        content: jsonData,
        encoding: 'utf8',
      });

      this.moduleLog('💾 Device fingerprint saved to: %s', filePath);

      // 同时输出摘要信息
      this.moduleLog('📱 Device Summary:');
      this.moduleLog(
        '   Brand: %s %s',
        fingerprint.device_info.brand,
        fingerprint.device_info.model
      );
      this.moduleLog(
        '   Android: %s (API %d)',
        fingerprint.device_info.android_version,
        fingerprint.device_info.api_level
      );
      this.moduleLog(
        '   Screen: %dx%d @%ddpi',
        fingerprint.device_info.screen_width,
        fingerprint.device_info.screen_height,
        fingerprint.device_info.density_dpi
      );
      this.moduleLog(
        '   SIM: %s (%s)',
        fingerprint.sim_info.simOperatorName || fingerprint.sim_info.simOperator || 'Unknown',
        fingerprint.sim_info.simCountryIso || 'Unknown'
      );
    } catch (e) {
      this.moduleLog('✗ Failed to save fingerprint file: %s', e);
    }
  }
}

async function activate(ctx: Ctx) {
  const { env, log, cfg } = ctx;

  if (env.platform !== 'android' || !env.javaAvailable) {
    log('Device fingerprint skipped: not Android or Java not available');
    return;
  }

  const moduleLog = makeModuleLogger('device-fingerprint');
  const outputFile = cfg.flags?.['fingerprint.outputFile'] || null;
  const autoSave = cfg.flags?.['fingerprint.autoSave'] !== false;

  await performOnJava(() => {
    try {
      const collector = new DeviceFingerprintCollector(moduleLog);

      // 收集设备指纹
      const fingerprint = collector.collectAll();

      // 自动保存到文件
      if (autoSave) {
        collector.saveToFile(fingerprint, outputFile);
      }

      // 也可以通过消息发送完整数据
      send({
        type: 'device_fingerprint',
        data: fingerprint,
      });

      moduleLog('🎯 Device fingerprint module completed successfully');
    } catch (e) {
      moduleLog('❌ Device fingerprint collection failed: %s', e);
    }
  });

  log('Android device fingerprint module activated');
}

export const meta: ModuleMeta = {
  id: 'android/device-fingerprint',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: ['fingerprint', 'device', 'info', 'detection', 'privacy'],
  },
  priority: 5, // 较低优先级，让其他模块先运行
  activate,
};
