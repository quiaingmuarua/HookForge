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
          // The bridge exposes a setter; its bundled typings mark it readonly.
          (Java.classFactory as { loader: unknown }).loader = app.getClassLoader();
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
