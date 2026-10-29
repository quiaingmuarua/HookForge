import { Ctx, ModuleMeta } from '@core/types';
import { makeModuleLogger } from '@core/log';
import { getJavaClass } from '@core/java-utils';
import { performOnJava } from '@core/java-bridge';

interface GlobalInfo {
  process: any;
  modules: any[];
  maps: string;
  jni: Array<[string, string, string]>;
  exports: Array<[string, string, string]>;
  dataDir?: string;
}

function getSelfMaps(): string {
  try {
    const fopen = new NativeFunction(Module.findExportByName('libc.so', 'fopen')!, 'pointer', [
      'pointer',
      'pointer',
    ]);
    const fgets = new NativeFunction(Module.findExportByName('libc.so', 'fgets')!, 'pointer', [
      'pointer',
      'int',
      'pointer',
    ]);
    const fclose = new NativeFunction(Module.findExportByName('libc.so', 'fclose')!, 'pointer', [
      'pointer',
    ]);

    const file = fopen(Memory.allocUtf8String('/proc/self/maps'), Memory.allocUtf8String('r'));
    if (file.isNull()) {
      return '';
    }

    let maps = '';
    const buffer = Memory.alloc(0x1000);
    const bufferSize = 0x1000;

    let ret = fgets(buffer, bufferSize, file);
    while (!ret.isNull()) {
      maps += buffer.readCString();
      ret = fgets(buffer, bufferSize, file);
    }

    fclose(file);
    return maps;
  } catch (e) {
    return '';
  }
}

async function activate(ctx: Ctx) {
  const { env, log, cfg } = ctx;

  if (env.platform !== 'android') {
    log('Info collector skipped: not Android platform');
    return;
  }

  const moduleLog = makeModuleLogger('info-collector');
  const collectMaps = cfg.flags?.['info.collectMaps'] !== false;
  const collectJNI = cfg.flags?.['info.collectJNI'] !== false;
  const collectExports = cfg.flags?.['info.collectExports'] !== false;

  const globalInfo: GlobalInfo = {
    process: {},
    modules: [],
    maps: '',
    jni: [],
    exports: [],
  };

  try {
    // Collect process information
    globalInfo.process = JSON.parse(JSON.stringify(Process));
    moduleLog('Process info collected: %s %s', Process.platform, Process.arch);

    // Collect modules information
    Process.enumerateModules().forEach(module => {
      const modulePath = module.path;

      // Filter interesting modules (app-specific, not system)
      if (
        !modulePath.includes('system') &&
        !modulePath.includes('vendor') &&
        !modulePath.includes('com.android') &&
        modulePath.includes('so') &&
        !modulePath.includes('linux') &&
        !modulePath.includes('frida') &&
        !modulePath.includes('code_cache')
      ) {
        // Collect exports if enabled
        if (collectExports || collectJNI) {
          try {
            module.enumerateExports().forEach(exportInfo => {
              const exportName = exportInfo.name.toLowerCase();
              const offset = (exportInfo.address as NativePointer)
                .sub(module.base as any)
                .toString();

              if (collectExports) {
                globalInfo.exports.push([modulePath, exportName, offset]);
              }

              if (collectJNI && exportName.includes('java')) {
                moduleLog('Found JNI function: %s in %s', exportName, module.name);
                globalInfo.jni.push([modulePath, exportName, offset]);
              }
            });
          } catch (e) {
            moduleLog('Failed to enumerate exports for %s: %s', module.name, e);
          }
        }

        globalInfo.modules.push(JSON.parse(JSON.stringify(module)));
      }
    });

    moduleLog(
      'Collected %d modules, %d exports, %d JNI functions',
      globalInfo.modules.length,
      globalInfo.exports.length,
      globalInfo.jni.length
    );

    // Collect memory maps if enabled
    if (collectMaps) {
      globalInfo.maps = getSelfMaps();
      moduleLog('Memory maps collected (%d bytes)', globalInfo.maps.length);
    }

    // Collect app data directory if Java is available
    if (env.javaAvailable) {
      await performOnJava(() => {
        try {
          const ActivityThread = getJavaClass('android.app.ActivityThread', true);
          const context = ActivityThread.currentApplication().getApplicationContext();
          if (context) {
            globalInfo.dataDir = context.getApplicationInfo().dataDir.value;
            moduleLog('App data directory: %s', globalInfo.dataDir);
          }
        } catch (e) {
          moduleLog('Failed to get data directory: %s', e);
        }
      });
    }

    // Send collected information
    send({
      type: 'info-collection',
      data: globalInfo,
      timestamp: Date.now(),
    });

    moduleLog('Information collection completed and sent');
  } catch (e) {
    moduleLog('Information collection failed: %s', e);
  }

  log('Android info collector module activated');
}

export const meta: ModuleMeta = {
  id: 'android/info-collector',
  selector: {
    platform: 'android',
    tags: ['info', 'collector', 'enumeration'],
  },
  priority: 5,
  activate,
};
