// Startup belongs to the App pack; Frida/session ownership stays in Node Host.
export async function waitReady(ctx, target) {
  if (!ctx.httpBase) {
    const port = ctx.forward(5566);
    ctx.log('Duck capability HTTP', { port, pid: target.pid });
    ctx.httpBase = 'http://127.0.0.1:' + port;
  }
  while (ctx.remainingMs() > 0 && !ctx.signal.aborted) {
    const activity = ctx.adb(['shell', 'dumpsys', 'activity', 'activities']);
    if (
      /(?:mResumedActivity:|ResumedActivity:|topResumedActivity=).*com\.detect\.app\.sample\/[^\s}]*DetectEnvMainActivity/.test(
        activity
      )
    ) {
      try {
        const response = await fetch(ctx.httpBase + '/health', {
          signal: AbortSignal.any([
            ctx.signal,
            AbortSignal.timeout(Math.min(2000, ctx.remainingMs())),
          ]),
        });
        if (response.ok) {
          return;
        }
      } catch {
        /* Readiness GET is repeatable; scans are never retried. */
      }
    }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Duck NativeActivity / main UI / capability HTTP not ready');
}
