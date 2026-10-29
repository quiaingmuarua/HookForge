// Readiness for the existing sensitive-files row; this helper never performs an action.
export type SensitiveFilesUi = {
  activityFocused: boolean;
  windowFocused: boolean;
  attached: boolean;
  shown: boolean;
  enabled: boolean;
  bounds: { left: number; top: number; right: number; bottom: number } | null;
};

export async function waitForSensitiveFilesTap(
  read: () => Promise<SensitiveFilesUi | null>,
  clock = {
    now: () => Date.now(),
    sleep: (milliseconds: number) =>
      new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
  }
): Promise<{ x: number; y: number }> {
  const deadline = clock.now() + 15000;
  let stableBounds: string | null = null;
  let stableSince = 0;
  let last: SensitiveFilesUi | null = null;
  while (clock.now() < deadline) {
    last = await read();
    const bounds = last?.bounds;
    if (
      last?.activityFocused &&
      last.windowFocused &&
      last.attached &&
      last.shown &&
      last.enabled &&
      bounds &&
      Object.values(bounds).every(Number.isFinite) &&
      bounds.right > bounds.left &&
      bounds.bottom > bounds.top
    ) {
      const signature = JSON.stringify(bounds);
      if (signature !== stableBounds) {
        stableBounds = signature;
        stableSince = clock.now();
      } else if (clock.now() - stableSince >= 300) {
        return {
          x: Math.floor((bounds.left + bounds.right) / 2),
          y: Math.floor((bounds.top + bounds.bottom) / 2),
        };
      }
    } else {
      stableBounds = null;
    }
    await clock.sleep(100);
  }
  throw new Error('Sensitive-files UI did not become focused and stable: ' + JSON.stringify(last));
}
