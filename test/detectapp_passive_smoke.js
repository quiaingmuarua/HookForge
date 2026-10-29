function log(message) {
  console.log(`[DETECTAPP-PASSIVE] ${message}`);
}

setImmediate(() => {
  log(`script loaded; pid=${Process.id} platform=${Process.platform} arch=${Process.arch}`);
  log(`Java.available=${Java.available}`);

  if (!Java.available) {
    return;
  }

  Java.perform(() => {
    log('Java.perform entered');

    const targetClass =
      'com.detect.app.sample.fingerprint_detect.unique_fingerprint.SettingPropInfoCollect';

    try {
      const loaderCount = Java.enumerateClassLoadersSync().length;
      log(`classLoaderCount=${loaderCount}`);
    } catch (e) {
      log(`class loader enumeration failed: ${e}`);
    }

    try {
      Java.enumerateLoadedClasses({
        onMatch(className) {
          if (className === targetClass) {
            log(`target class already loaded: ${className}`);
          }
        },
        onComplete() {
          log('loaded-class scan completed');
        },
      });
    } catch (e) {
      log(`loaded-class scan failed: ${e}`);
    }
  });
});
