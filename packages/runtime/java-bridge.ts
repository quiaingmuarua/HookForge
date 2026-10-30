import JavaBridge from 'frida-java-bridge';

export const Java = JavaBridge;

export function isJavaAvailable(): boolean {
  try {
    return Java.available === true;
  } catch {
    return false;
  }
}

/** Resolve the app loader through boot classes before queuing Java.perform(). */
export async function initializeJavaClassLoader(
  timeoutMs: number,
  cancelled: () => boolean = () => false
): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  do {
    if (cancelled()) {
      return false;
    }
    if (isJavaAvailable()) {
      if (Java.classFactory.loader !== null) {
        return true;
      }
      let ready = false;
      Java.performNow(() => {
        const app = Java.use('android.app.ActivityThread').currentApplication();
        if (app !== null) {
          // Like the bridge's Application initialization, establish writable
          // app-private DEX paths before publishing the loader. Setting only
          // loader bypasses its initialization and leaves /data/local/tmp,
          // which a freshly installed non-root App cannot write.
          const cacheDir = String(app.getCacheDir().getCanonicalPath());
          const codeCacheDir = String(app.getCodeCacheDir().getCanonicalPath());
          const loader = app.getClassLoader();
          // codeCacheDir exists in the pinned bridge, but is absent from its types.
          const factory = Java.classFactory as unknown as {
            loader: unknown;
            cacheDir: string;
            codeCacheDir: string;
          };
          factory.cacheDir = cacheDir;
          factory.codeCacheDir = codeCacheDir;
          factory.loader = loader;
          ready = true;
        }
      });
      if (ready) {
        return true;
      }
    }
    if (Date.now() >= deadline) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, Math.min(50, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return false;
}

export async function performOnJava<T>(fn: () => T | Promise<T>): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    try {
      Java.perform(() => {
        // perform() may defer this callback until the app class loader is ready.
        // Catch here as well so a deferred synchronous throw rejects the caller.
        try {
          Promise.resolve(fn()).then(resolve, reject);
        } catch (error) {
          reject(error);
        }
      });
    } catch (error) {
      reject(error);
    }
  });
}
