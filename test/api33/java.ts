import { initializeJavaClassLoader, Java, performOnJava } from '../../packages/core/java-bridge';

const targetClass = 'com.detect.app.sample.tool.FileHelper';
const probePath = '/proc/self/status';
const jniSymbol = 'Java_com_detect_app_sample_tool_FileHelper_check_1file_1exist_1c';
let javaMethod: any = null;
let javaHits = 0;
let javaProbe = false;
let nativeListener: InvocationListener | null = null;
let nativeProbeThread: number | null = null;
let nativeHits = 0;

async function withTarget<T>(fn: (klass: any) => T): Promise<T> {
  return performOnJava(() => fn(Java.use(targetClass)));
}

rpc.exports = {
  async info() {
    if (!(await initializeJavaClassLoader(60000))) {
      throw new Error('detect-env Application ClassLoader was not ready within 60 seconds');
    }
    return performOnJava(() => {
      const app = Java.use('android.app.ActivityThread').currentApplication();
      Java.use(targetClass).fileExistResult(probePath);
      const module = Process.getModuleByName('libdetect_sample.so');
      return {
        javaAvailable: Java.available,
        hasJavaGlobal: typeof (globalThis as any).Java !== 'undefined',
        package: String(app.getPackageName()),
        sdk: Java.use('android.os.Build$VERSION').SDK_INT.value,
        className: targetClass,
        classLoader: String(Java.classFactory.loader),
        jniSymbol,
        jniAddress: module.getExportByName(jniSymbol).toString(),
        library: module.path,
      };
    });
  },
  async probejava() {
    return withTarget(klass => {
      javaProbe = true;
      try {
        return Boolean(klass.fileExistResult(probePath));
      } finally {
        javaProbe = false;
      }
    });
  },
  expectedfailure() {
    return performOnJava(() => {
      throw new Error('API33_EXPECTED_JAVA_RPC_ERROR');
    });
  },
  async installjava() {
    return withTarget(klass => {
      if (javaMethod !== null) {
        throw new Error('Java hook already installed');
      }
      const method = klass.fileExistResult.overload('java.lang.String');
      method.implementation = function (this: any, path: any) {
        const original = Boolean(method.call(this, path));
        if (!javaProbe || String(path) !== probePath) {
          return original;
        }
        javaHits += 1;
        send({
          type: 'java-hook-hit',
          className: targetClass,
          method: 'fileExistResult',
          original,
          replacement: false,
          hits: javaHits,
        });
        return false;
      };
      javaMethod = method;
      return true;
    });
  },
  async removejava() {
    return performOnJava(() => {
      if (javaMethod !== null) {
        javaMethod.implementation = null;
      }
      javaMethod = null;
      return javaHits;
    });
  },
  async probejni() {
    return withTarget(klass => {
      nativeProbeThread = Process.getCurrentThreadId();
      try {
        return Number(klass.check_file_exist_c(probePath));
      } finally {
        nativeProbeThread = null;
      }
    });
  },
  async installjni() {
    return withTarget(() => {
      if (nativeListener !== null) {
        throw new Error('JNI hook already installed');
      }
      const address = Process.getModuleByName('libdetect_sample.so').getExportByName(jniSymbol);
      nativeListener = Interceptor.attach(address, {
        onEnter() {
          this.isProbe = this.threadId === nativeProbeThread;
        },
        onLeave(retval) {
          if (!this.isProbe) {
            return;
          }
          const original = retval.toInt32();
          retval.replace(0);
          nativeHits += 1;
          send({
            type: 'jni-hook-hit',
            symbol: jniSymbol,
            original,
            replacement: 0,
            hits: nativeHits,
          });
        },
      });
      Interceptor.flush();
      return true;
    });
  },
  removejni() {
    if (nativeListener !== null) {
      nativeListener.detach();
    }
    nativeListener = null;
    Interceptor.flush();
    return nativeHits;
  },
};

send({ type: 'java-agent-loaded', bridge: 'packages/core/java-bridge', pid: Process.id });
