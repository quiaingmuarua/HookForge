import type { Java, performOnJava } from '@runtime/java-bridge';
import type { ApiObservation } from '@modules/android-runtime-bypass/api-hooks';
import type { AndroidApiPolicy } from '@modules/android-runtime-bypass/api-policy';

export type Cleanup = () => void | Promise<void>;
export type ExtensionContext = {
  id: string;
  modes: string[];
  Java: typeof Java;
  performOnJava: typeof performOnJava;
  log: (message: string) => void;
  emit: (type: string, data?: unknown) => void;
  api: {
    policy: () => AndroidApiPolicy;
    subscribe: (listener: (event: ApiObservation) => void) => Cleanup;
  };
  scope: { own: (hookId: string, cleanup: Cleanup) => void; defer: (cleanup: Cleanup) => void };
};
