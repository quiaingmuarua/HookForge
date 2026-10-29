import type { ExtensionContext } from '../../packages/composition/types';
import { buildFieldNames } from '../../packages/modules/android-runtime-bypass/api-policy';
import { installControls } from '../duck-system-properties/probe-controls';

// Standard API controls only; never invoke or intercept an SDK detector.
export function activate(ctx: ExtensionContext) {
  const previous = { ...rpc.exports };
  const stop = installControls();
  rpc.exports = {
    ...rpc.exports,
    async casefields(keys: string[]) {
      return ctx.performOnJava(() => {
        const Build = ctx.Java.use('android.os.Build');
        const Version = ctx.Java.use('android.os.Build$VERSION');
        const properties = ctx.Java.use('android.os.SystemProperties');
        return {
          fields: Object.fromEntries(
            buildFieldNames.map(name => [name, String(Build[name].value)])
          ),
          properties: Object.fromEntries(
            keys.map(key => [
              key,
              String(
                properties.get
                  .overload('java.lang.String', 'java.lang.String')
                  .call(properties, key, 'AF_PROPERTY_MISSING')
              ),
            ])
          ),
          unrelated: {
            id: String(Build.ID.value),
            display: String(Build.DISPLAY.value),
            release: String(Version.RELEASE.value),
            incremental: String(Version.INCREMENTAL.value),
            api: Number(Version.SDK_INT.value),
            abis: Array.from(Build.SUPPORTED_ABIS.value, String),
          },
        };
      });
    },
  };
  return () => {
    stop();
    rpc.exports = previous;
  };
}
