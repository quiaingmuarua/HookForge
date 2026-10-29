import { androidApi } from './api-runtime';
import { AndroidApiPolicy } from './api-policy';

// Experiment adapters in the same Script share this bridge and its ART lifecycle.
export { Java, initializeJavaClassLoader, performOnJava } from '@runtime/java-bridge';
export { androidApi } from './api-runtime';

rpc.exports = {
  async configure(policy: AndroidApiPolicy) {
    return androidApi.configure(policy);
  },
  drain() {
    return androidApi.drain();
  },
  async dispose() {
    return androidApi.dispose();
  },
};
