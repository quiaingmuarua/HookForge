import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';
import { getSpoofManager } from '@core/spoof-manager';
import { getJavaClass } from '@core/java-utils';
import { performOnJava } from '@core/java-bridge';

const SIM_HOOKS = [
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getSimOperator',
    type: 'sim_info' as const,
    field: 'simOperator',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getSimOperatorName',
    type: 'sim_info' as const,
    field: 'simOperatorName',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getSimCountryIso',
    type: 'sim_info' as const,
    field: 'simCountryIso',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getNetworkOperator',
    type: 'sim_info' as const,
    field: 'networkOperator',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getNetworkOperatorName',
    type: 'sim_info' as const,
    field: 'networkOperatorName',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getNetworkCountryIso',
    type: 'sim_info' as const,
    field: 'networkCountryIso',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getSimSerialNumber',
    type: 'sim_info' as const,
    field: 'simSerialNumber',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getSubscriberId',
    type: 'sim_info' as const,
    field: 'subscriberId',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getLine1Number',
    type: 'sim_info' as const,
    field: 'line1Number',
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getSimCarrierId',
    type: 'sim_info' as const,
    field: 'carrierId',
    targetType: 'number' as const,
    logPrefix: '[SIM] ',
  },
  {
    className: 'android.telephony.TelephonyManager',
    methodName: 'getSimSpecificCarrierId',
    type: 'sim_info' as const,
    field: 'specificCarrierId',
    targetType: 'number' as const,
    logPrefix: '[SIM] ',
  },
];

async function activate(ctx: Ctx) {
  const { env, log, cfg } = ctx;

  if (env.platform !== 'android' || !env.javaAvailable) {
    log('SIM collector skipped: not Android or Java not available');
    return;
  }

  const moduleLog = makeModuleLogger('sim-collector');
  const logSimInfo = cfg.flags?.['sim.logInfo'] !== false;
  const enableSpoofing = cfg.flags?.['sim.enableSpoofing'] === true;
  const strictMode = cfg.flags?.['hook.strictMode'] === true;
  const spoofManager = getSpoofManager();

  if (enableSpoofing) {
    const config = spoofManager.loadConfig();
    if (config) {
      moduleLog('Universal spoof config loaded, SIM spoofing enabled');
    } else {
      moduleLog('Spoof config not found, SIM spoofing disabled');
    }
  }

  await performOnJava(() => {
    try {
      const hookedCount = spoofManager.hookMethods(SIM_HOOKS, enableSpoofing, strictMode);

      if (hookedCount > 0) {
        moduleLog('SIM collector activated, hooked %d TelephonyManager methods', hookedCount);
        if (enableSpoofing) {
          moduleLog('SIM spoofing enabled');
        }
      } else {
        moduleLog('No SIM methods were hooked successfully');
      }

      try {
        const TelephonyManager = getJavaClass('android.telephony.TelephonyManager', false);
        if (TelephonyManager) {
          let hasIccCard = null;
          try {
            hasIccCard = TelephonyManager.hasIccCard.overload();
          } catch (e) {
            moduleLog(
              'SIM status monitoring skipped: hasIccCard is not available on this target%s: %s',
              strictMode ? ' (strict mode continues for compatibility gaps)' : '',
              e
            );
          }

          if (hasIccCard) {
            hasIccCard.implementation = function () {
              const result = hasIccCard.call(this);
              if (logSimInfo) {
                moduleLog('[SIM] Has ICC Card: %s', result);
              }
              return result;
            };
          }
        } else if (strictMode) {
           throw new Error('Class android.telephony.TelephonyManager not found');
        }
      } catch (e) {
        if (strictMode) {
          throw e;
        }
        moduleLog('Additional SIM status monitoring failed: %s', e);
      }
    } catch (e) {
      if (strictMode) {
        throw e;
      }
      moduleLog('SIM collector setup failed: %s', e);
    }
  });

  log('Android SIM collector module activated');
}

async function deactivate(ctx: Ctx) {
  const { log } = ctx;
  const spoofManager = getSpoofManager();
  spoofManager.unhookAll();
  log('Android SIM collector module deactivated');
}

export const meta: ModuleMeta = {
  id: 'android/sim-collector',
  selector: {
    platform: 'android',
    layer: 'java',
    tags: ['sim', 'info', 'telephony', 'collector'],
  },
  priority: 8,
  activate,
  deactivate,
};
