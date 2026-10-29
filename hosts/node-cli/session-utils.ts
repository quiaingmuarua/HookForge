/** Shared by the existing smoke Host and composable foreground sessions. */
export async function boundedOperation<T>(
  operation: () => Promise<T>,
  label: string,
  limitMs: number,
  signal?: AbortSignal
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let abort: (() => void) | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(label + ' timeout')), Math.max(1, limitMs));
        if (signal) {
          abort = () => reject(new Error(label + ' interrupted'));
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) {
            abort();
          }
        }
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (abort) {
      signal?.removeEventListener('abort', abort);
    }
  }
}

export async function attachScript(
  device: any,
  pid: number,
  source: string,
  name: string,
  bounded: <T>(operation: () => Promise<T>, label: string) => Promise<T>,
  onSession: (session: any) => void
) {
  const session: any = await bounded(() => device.attach(pid), 'attach');
  // Register ownership immediately so a partial createScript failure detaches.
  onSession(session);
  return bounded(() => session.createScript(source, { name }), 'create script');
}
