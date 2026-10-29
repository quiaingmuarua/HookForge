'use strict';

// This probe changes only its own access() call in the detect-env process.
const probePath = '/proc/self/status';
const accessAddress = Process.getModuleByName('libc.so').getExportByName('access');
const access = new NativeFunction(accessAddress, 'int', ['pointer', 'int']);
const pathBuffer = Memory.allocUtf8String(probePath);
/** @type {InvocationListener | null} */
let listener = null;
/** @type {number | null} */
let probeThread = null;
let hits = 0;

rpc.exports = {
  info() {
    return {
      pid: Process.id,
      arch: Process.arch,
      platform: Process.platform,
      runtime: Script.runtime,
      hasJavaGlobal: typeof Java !== 'undefined',
      symbol: 'libc.so!access',
      address: accessAddress.toString(),
      path: probePath,
      hits,
    };
  },
  /** @param {unknown} value */
  echo(value) {
    return value;
  },
  /** @param {number} a @param {number} b */
  asyncadd(a, b) {
    return new Promise(resolve => setTimeout(() => resolve(a + b), 10));
  },
  expectedfailure() {
    throw new Error('API33_EXPECTED_RPC_ERROR');
  },
  probe() {
    probeThread = Process.getCurrentThreadId();
    try {
      return access(pathBuffer, 0);
    } finally {
      probeThread = null;
    }
  },
  install() {
    if (listener !== null) {
      throw new Error('Native hook already installed');
    }
    listener = Interceptor.attach(accessAddress, {
      onEnter(args) {
        this.isProbe = this.threadId === probeThread && args[0].equals(pathBuffer);
      },
      onLeave(retval) {
        if (!this.isProbe) {
          return;
        }
        const original = retval.toInt32();
        retval.replace(-1);
        this.errno = 2;
        hits += 1;
        send({ type: 'native-hook-hit', symbol: 'access', original, replacement: -1, hits });
      },
    });
    Interceptor.flush();
    return true;
  },
  remove() {
    if (listener !== null) {
      listener.detach();
    }
    listener = null;
    Interceptor.flush();
    return hits;
  },
};

send({ type: 'native-agent-loaded', pid: Process.id, runtime: Script.runtime });
