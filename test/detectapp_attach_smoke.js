function log(message) {
  console.log(`[DETECTAPP] ${message}`);
}

function tryGetContext() {
  try {
    const ActivityThread = Java.use('android.app.ActivityThread');
    const app = ActivityThread.currentApplication();
    if (!app) {
      log('currentApplication is null');
      return null;
    }
    return app.getApplicationContext();
  } catch (e) {
    log(`context lookup failed: ${e}`);
    return null;
  }
}

function tryFindTargetClass(className) {
  try {
    const klass = Java.use(className);
    log(`class resolved via default loader: ${className}`);
    return klass;
  } catch (_e) {
    // Fall through to class-loader scan.
  }

  try {
    for (const loader of Java.enumerateClassLoadersSync()) {
      try {
        loader.findClass(className);
        const klass = Java.ClassFactory.get(loader).use(className);
        log(`class resolved via enumerated loader: ${className}`);
        return klass;
      } catch (_ignored) {
        // Continue searching.
      }
    }
  } catch (e) {
    log(`class loader scan failed: ${e}`);
  }

  log(`class not found: ${className}`);
  return null;
}

setImmediate(() => {
  log(`script loaded; pid=${Process.id} platform=${Process.platform} arch=${Process.arch}`);
  log(`Java.available=${Java.available}`);

  if (!Java.available) {
    return;
  }

  let attempts = 0;
  const maxAttempts = 6;
  const targetClass =
    'com.detect.app.sample.fingerprint_detect.unique_fingerprint.SettingPropInfoCollect';

  const timer = setInterval(() => {
    attempts += 1;

    Java.perform(() => {
      log(`probe attempt ${attempts}/${maxAttempts}`);

      const context = tryGetContext();
      if (context) {
        log(`package=${context.getPackageName()}`);
      }

      const klass = tryFindTargetClass(targetClass);
      if (klass && context) {
        try {
          const result = klass.getAllInfo(context);
          const text = String(result);
          log(`getAllInfo success, length=${text.length}`);
          log(`result preview=${text.slice(0, 200)}`);
        } catch (e) {
          log(`getAllInfo invocation failed: ${e}`);
        }
        clearInterval(timer);
        return;
      }

      if (attempts >= maxAttempts) {
        log('probe limit reached');
        clearInterval(timer);
      }
    });
  }, 2000);
});
