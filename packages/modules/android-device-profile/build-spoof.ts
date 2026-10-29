import { Ctx, ModuleMeta } from '../../core/types';
import { makeModuleLogger } from '../../core/log';
import { getSpoofManager } from '../../core/spoof-manager';
import { Java, performOnJava } from '../../core/java-bridge';

async function activate(ctx: Ctx) {
  const { env, log, cfg } = ctx;

  if (env.platform !== 'android' || !env.javaAvailable) {
    log('Build spoof skipped: not Android or Java not available');
    return;
  }

  const moduleLog = makeModuleLogger('build-spoof');
  const logBuildInfo = cfg.flags?.['build.logInfo'] !== false;
  const enableSpoofing = cfg.flags?.['build.enableSpoofing'] === true;
  const spoofManager = getSpoofManager();

  if (enableSpoofing) {
    const config = spoofManager.loadConfig();
    if (config?.device_info) {
      moduleLog('Universal spoof config loaded, build spoofing enabled');
    } else {
      moduleLog('Device profile spoof config not found, build spoofing disabled');
    }
  }

  await performOnJava(() => {
    try {
      const Build = Java.use('android.os.Build');
      const BuildVersion = Java.use('android.os.Build$VERSION');

      if (enableSpoofing) {
        const deviceConfig = spoofManager.getConfig('device_info');
        if (deviceConfig) {
          const assignIfPresent = (label: string, field: any, value: unknown) => {
            if (value === undefined || value === null) {
              return;
            }
            field.value = value;
            if (logBuildInfo) {
              moduleLog('[BUILD] %s: %s (spoofed)', label, value);
            }
          };

          assignIfPresent('BRAND', Build.BRAND, String(deviceConfig.brand ?? ''));
          assignIfPresent('MANUFACTURER', Build.MANUFACTURER, String(deviceConfig.manufacturer ?? ''));
          assignIfPresent('MODEL', Build.MODEL, String(deviceConfig.model ?? ''));
          assignIfPresent('DEVICE', Build.DEVICE, String(deviceConfig.device ?? ''));
          assignIfPresent('PRODUCT', Build.PRODUCT, String(deviceConfig.product ?? ''));
          assignIfPresent('HARDWARE', Build.HARDWARE, String(deviceConfig.hardware ?? ''));
          assignIfPresent('BOARD', Build.BOARD, String(deviceConfig.board ?? ''));
          assignIfPresent('FINGERPRINT', Build.FINGERPRINT, String(deviceConfig.fingerprint ?? ''));
          assignIfPresent('BOOTLOADER', Build.BOOTLOADER, String(deviceConfig.bootloader ?? ''));
          assignIfPresent('ID', Build.ID, String(deviceConfig.build_id ?? ''));
          assignIfPresent('RELEASE', BuildVersion.RELEASE, String(deviceConfig.android_version ?? ''));

          if (deviceConfig.api_level !== undefined) {
            BuildVersion.SDK_INT.value = Number(deviceConfig.api_level);
            if (logBuildInfo) {
              moduleLog('[VERSION] SDK_INT: %d (spoofed)', deviceConfig.api_level);
            }
          }

          if (deviceConfig.security_patch) {
            BuildVersion.SECURITY_PATCH.value = String(deviceConfig.security_patch);
            if (logBuildInfo) {
              moduleLog('[VERSION] SECURITY_PATCH: %s (spoofed)', deviceConfig.security_patch);
            }
          }
        }
      }

      try {
        const SettingsSecure = Java.use('android.provider.Settings$Secure');
        const getString = SettingsSecure.getString.overload(
          'android.content.ContentResolver',
          'java.lang.String'
        );
        getString.implementation = function (resolver: any, name: string) {
          const originalResult = getString.call(this, resolver, name);

          if (name === 'android_id' && enableSpoofing) {
            const deviceConfig = spoofManager.getConfig('device_info');
            if (deviceConfig?.android_id) {
              const spoofedResult = String(deviceConfig.android_id);
              if (logBuildInfo) {
                moduleLog('[SETTINGS] Android ID: %s -> %s (spoofed)', originalResult, spoofedResult);
              }
              return spoofedResult;
            }
          }

          if (logBuildInfo && name === 'android_id') {
            moduleLog('[SETTINGS] Android ID: %s', originalResult);
          }

          return originalResult;
        };
      } catch (e) {
        moduleLog('Settings.Secure.getString hook failed: %s', e);
      }

      moduleLog('Build spoof module activated');
      if (enableSpoofing) {
        moduleLog('Device profile spoofing enabled');
      }
    } catch (e) {
      moduleLog('Build spoof setup failed: %s', e);
    }
  });

  log('Android build spoof module activated');
}

export const meta: ModuleMeta = {
  id: 'android/build-spoof',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: ['build', 'device', 'spoof', 'fingerprint'],
  },
  priority: 8,
  activate,
};
