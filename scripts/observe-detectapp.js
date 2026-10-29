/**
 * observe-detectapp.js
 *
 * Frida CLI script for com.detect.app.sample.
 * Hooks all major detection classes and prints results when called.
 *
 * Usage:
 *   frida -U -q -f com.detect.app.sample -l observe-detectapp.js
 */

Java.perform(function () {
  var TAG = '[detect-hook]';

  // ── Helper ──────────────────────────────────────────────────────────────────
  function hookAllInfo(className, label) {
    try {
      var Cls = Java.use(className);
      if (Cls.getAllInfo) {
        // Some getAllInfo(Context), some getAllInfo()
        Cls.getAllInfo.overloads.forEach(function (overload) {
          overload.implementation = function () {
            var result = overload.apply(this, arguments);
            console.log(TAG + ' [' + label + '] getAllInfo =>\n' + result);
            return result;
          };
        });
        console.log(TAG + ' Hooked: ' + label);
      }
    } catch (e) {
      console.log(TAG + ' Hook failed for ' + label + ': ' + e);
    }
  }

  // ── Risk / File Detection ────────────────────────────────────────────────────
  hookAllInfo('com.detect.app.sample.risk_detect.file_detect.FileExistCheck',          'FileExistCheck');
  hookAllInfo('com.detect.app.sample.risk_detect.file_detect.FileContentCheck',        'FileContentCheck');
  hookAllInfo('com.detect.app.sample.risk_detect.memory_detect.MemoryCheck',           'MemoryCheck');
  hookAllInfo('com.detect.app.sample.risk_detect.shell_detect.ShellCheck',             'ShellCheck');
  hookAllInfo('com.detect.app.sample.risk_detect.system_detect.ClassLoaderStateCheck', 'ClassLoaderStateCheck');
  hookAllInfo('com.detect.app.sample.risk_detect.system_detect.DebugStateCheck',       'DebugStateCheck');
  hookAllInfo('com.detect.app.sample.risk_detect.system_detect.DevicePropertyCheck',   'DevicePropertyCheck');
  hookAllInfo('com.detect.app.sample.risk_detect.system_detect.PmcCheck',             'PmcCheck');

  // ── Fingerprint / Unique ID Collection ──────────────────────────────────────
  hookAllInfo('com.detect.app.sample.fingerprint_detect.unique_fingerprint.AppInfoCollect',         'AppInfoCollect');
  hookAllInfo('com.detect.app.sample.fingerprint_detect.unique_fingerprint.SystemInfoCollect',      'SystemInfoCollect');

  // ── System property hook – see exactly which props are read ─────────────────
  try {
    var SystemProperties = Java.use('android.os.SystemProperties');
    var origGet = SystemProperties.get.overload('java.lang.String');
    origGet.implementation = function (key) {
      var val = origGet.call(this, key);
      // Only log security-sensitive props to avoid log spam
      var watchKeys = ['ro.debuggable', 'service.adb.root', 'ro.secure', 'ro.build.tags',
                       'ro.build.fingerprint', 'ro.kernel.qemu', 'ro.boot.flash.locked',
                       'ro.allow.mock.location', 'ro.build.selinux'];
      if (watchKeys.indexOf(key) !== -1) {
        console.log(TAG + ' [SystemProperties.get] ' + key + ' = ' + val);
      }
      return val;
    };
    console.log(TAG + ' Hooked: SystemProperties.get');
  } catch (e) {
    console.log(TAG + ' SystemProperties hook failed: ' + e);
  }

  // ── java.io.File.exists() – see which root files are probed ─────────────────
  try {
    var File = Java.use('java.io.File');
    var origExists = File.exists.overload();
    origExists.implementation = function () {
      var path = File.getPath.call(this);
      var result = origExists.call(this);
      var rootPaths = ['/su/', 'magisk', 'supersu', 'xposed', 'riru', '/sbin/su', '/system/bin/su'];
      for (var i = 0; i < rootPaths.length; i++) {
        if (path.indexOf(rootPaths[i]) !== -1) {
          console.log(TAG + ' [File.exists] ' + path + ' => ' + result);
          break;
        }
      }
      return result;
    };
    console.log(TAG + ' Hooked: File.exists');
  } catch (e) {
    console.log(TAG + ' File.exists hook failed: ' + e);
  }

  console.log(TAG + ' ====== All hooks installed, waiting for detection calls... ======');
});
