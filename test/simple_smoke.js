setImmediate(() => {
  console.log('[SMOKE] script loaded');
  console.log(`[SMOKE] process=${Process.id} platform=${Process.platform} arch=${Process.arch}`);
  console.log(`[SMOKE] Java.available=${Java.available}`);

  if (!Java.available) {
    console.log('[SMOKE] Java not available');
    return;
  }

  setTimeout(() => {
    Java.perform(() => {
      console.log('[SMOKE] Java.perform entered');
      try {
        const ActivityThread = Java.use('android.app.ActivityThread');
        const app = ActivityThread.currentApplication();
        if (!app) {
          console.log('[SMOKE] currentApplication is null');
          return;
        }

        const context = app.getApplicationContext();
        console.log(`[SMOKE] package=${context.getPackageName()}`);
      } catch (e) {
        console.log(`[SMOKE] delayed Java probe failed: ${e}`);
      }
    });
  }, 3000);
});
