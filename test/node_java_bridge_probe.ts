import Java from 'frida-java-bridge';

send({
  type: 'java-bridge-probe',
  phase: 'load',
  hasJavaGlobal: typeof (globalThis as any).Java !== 'undefined',
});

setTimeout(() => {
  send({
    type: 'java-bridge-probe',
    phase: 't+1000ms',
    hasJavaGlobal: typeof (globalThis as any).Java !== 'undefined',
  });
}, 1000);

setTimeout(() => {
  send({
    type: 'java-bridge-probe',
    phase: 't+3000ms',
    hasJavaGlobal: typeof (globalThis as any).Java !== 'undefined',
  });
}, 3000);

try {
  Java.perform(() => {
    const ActivityThread = Java.use('android.app.ActivityThread');
    const app = ActivityThread.currentApplication();
    send({
      type: 'java-bridge-probe',
      phase: 'perform',
      javaAvailable: Java.available,
      currentApplication: app ? app.toString() : null,
    });
  });
} catch (error) {
  send({
    type: 'java-bridge-probe',
    phase: 'perform-error',
    error: String(error),
  });
}
