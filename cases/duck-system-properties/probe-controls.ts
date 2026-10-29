// Supplemental controls only. Duck is triggered exclusively through its existing
// HTTP event. No SDK method is called or observed from this adapter.
import { Java, initializeJavaClassLoader, performOnJava } from '../../packages/runtime/java-bridge';

function output(child: any) {
  const read = (stream: any) => {
    const scanner = Java.use('java.util.Scanner').$new(stream).useDelimiter('\\A');
    try {
      return scanner.hasNext() ? String(scanner.next()) : '';
    } finally {
      scanner.close();
    }
  };
  const stdout = read(child.getInputStream());
  const stderr = read(child.getErrorStream());
  return { stdout, stderr, exitCode: Number(child.waitFor()) };
}

export function installControls() {
  const previous = { ...rpc.exports };
  rpc.exports = {
    ...rpc.exports,
    async caseinfo() {
      if (!(await initializeJavaClassLoader(15000))) {
        throw new Error('Application ClassLoader not ready');
      }
      return performOnJava(() => {
        const app = Java.use('android.app.ActivityThread').currentApplication();
        return {
          package: String(app.getPackageName()),
          pid: Process.id,
          arch: Process.arch,
          api: Number(Java.use('android.os.Build$VERSION').SDK_INT.value),
        };
      });
    },
    async casecontrols() {
      return performOnJava(() => {
        const properties = Java.use('android.os.SystemProperties');
        const app = Java.use('android.app.ActivityThread').currentApplication();
        const runtime = Java.use('java.lang.Runtime').getRuntime();
        const args = Java.array('java.lang.String', [
          '/system/bin/sh',
          '-c',
          'printf control-out; printf control-error >&2; exit 7',
        ]);
        const start = () => Java.use('java.lang.ProcessBuilder').$new(args).start();
        const missing = (builder: boolean) => {
          try {
            const argv = Java.array('java.lang.String', [
              '/system/bin/agentforge-nonexistent-command',
            ]);
            const child = builder
              ? Java.use('java.lang.ProcessBuilder').$new(argv).start()
              : runtime.exec(argv);
            child.destroy();
            return false;
          } catch (error) {
            return String(error).includes('java.io.IOException');
          }
        };
        return {
          sdk: String(
            properties.get.overload('java.lang.String').call(properties, 'ro.build.version.sdk')
          ),
          sdkDefault: String(
            properties.get
              .overload('java.lang.String', 'java.lang.String')
              .call(properties, 'ro.build.version.sdk', 'unused')
          ),
          missingDefault: String(
            properties.get
              .overload('java.lang.String', 'java.lang.String')
              .call(properties, 'agentforge.nonexistent', 'control-default')
          ),
          ownPackage: String(
            app.getPackageManager().getPackageInfo(String(app.getPackageName()), 0).packageName
              .value
          ),
          fileExists: Boolean(Java.use('java.io.File').$new('/proc/self/status').exists()),
          runtime: output(runtime.exec(args)),
          builder: output(start()),
          missingRuntime: missing(false),
          missingBuilder: missing(true),
        };
      });
    },
  };

  return () => {
    rpc.exports = previous;
  };
}
