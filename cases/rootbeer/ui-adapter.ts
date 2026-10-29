// APK adapter only: trigger its normal UI and read its unmodified results.
import { initializeJavaClassLoader, Java, performOnJava } from '../../packages/runtime/java-bridge';
import { sample } from './catalog.mjs';

let app: any;
let activity: any;
let uiResults: { label: string; value: boolean }[] | null = null;
let uiFinished: boolean | null = null;
let observerFailure: string | null = null;
const observers: any[] = [];

async function findActivity() {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const found = await performOnJava(
      () =>
        new Promise<any>(resolve => {
          let match: any = null;
          Java.choose('com.scottyab.rootbeer.sample.MainActivity', {
            onMatch(value: any) {
              if (!value.isFinishing()) {
                match = Java.retain(value);
                return 'stop';
              }
              return undefined;
            },
            onComplete() {
              resolve(match);
            },
          });
        })
    );
    if (found) {
      return found;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('RootBeer main Activity was not ready');
}

function onMain<T>(fn: () => T): Promise<T> {
  return new Promise<T>((resolve, reject) =>
    Java.scheduleOnMainThread(() => {
      try {
        resolve(fn());
      } catch (error) {
        reject(error);
      }
    })
  );
}

export function installUiAdapter(
  onResult?: (result: { pid: number; rooted: boolean; checks: typeof uiResults }) => void
) {
  const previous = { ...rpc.exports };
  rpc.exports = {
    ...rpc.exports,
    async init() {
      if (!(await initializeJavaClassLoader(15000))) {
        throw new Error('RootBeer Application ClassLoader not ready');
      }
      const info = await performOnJava(() => {
        app = Java.use('android.app.ActivityThread').currentApplication();
        const klass = Java.use('com.scottyab.rootbeer.sample.MainActivity');
        const animate = klass.animateResults.overload('java.util.List');
        animate.implementation = function (this: any, list: any) {
          const result = animate.call(this, list);
          try {
            uiResults = [];
            for (let index = 0; index < list.size(); index++) {
              const item = Java.cast(
                list.get(index),
                Java.use('com.scottyab.rootbeer.sample.RootItemResult')
              );
              uiResults.push({ label: String(item.getText()), value: Boolean(item.getResult()) });
            }
          } catch (error) {
            observerFailure = String(error);
          }
          return result;
        };
        const finish = klass.onRootCheckFinished.overload('boolean');
        finish.implementation = function (this: any, rooted: boolean) {
          const result = finish.call(this, rooted);
          uiFinished = Boolean(rooted);
          try {
            onResult?.({ pid: Process.id, rooted: uiFinished, checks: uiResults });
          } catch (error) {
            observerFailure = String(error);
          }
          return result;
        };
        observers.push(animate, finish);
        return {
          package: String(app.getPackageName()),
          version: String(
            app.getPackageManager().getPackageInfo(sample.package, 0).versionName.value
          ),
          sdk: Number(Java.use('android.os.Build$VERSION').SDK_INT.value),
          arch: Process.arch,
          tags: String(Java.use('android.os.Build').TAGS.value),
        };
      });
      activity = await findActivity();
      return info;
    },
    async prepareui() {
      uiResults = null;
      uiFinished = null;
      observerFailure = null;
      return onMain(() => {
        const id = app.getResources().getIdentifier('fab', 'id', sample.package);
        const button = Java.cast(activity.findViewById(id), Java.use('android.view.View'));
        const location = Java.array('int', [0, 0]);
        button.getLocationOnScreen(location);
        return {
          x: Number(location[0]) + Math.floor(button.getWidth() / 2),
          y: Number(location[1]) + Math.floor(button.getHeight() / 2),
        };
      });
    },
    async ui() {
      if (observerFailure) {
        throw new Error('UI observation failed: ' + observerFailure);
      }
      const deadline = Date.now() + 25000;
      let complete = false;
      while (Date.now() < deadline) {
        complete = await onMain(() => {
          if (uiFinished === null || uiResults === null) {
            return false;
          }
          // This sample reports completion during the last row's animation.
          // Wait for all original rows and the fully shown repeat control.
          const button = Java.cast(
            activity.findViewById(app.getResources().getIdentifier('fab', 'id', sample.package)),
            Java.use('android.view.View')
          );
          const adapter = Java.cast(
            activity.rootItemAdapter.value,
            Java.use('androidx.recyclerview.widget.RecyclerView$Adapter')
          );
          return (
            Number(adapter.getItemCount()) === uiResults.length &&
            Boolean(button.isShown()) &&
            Number(button.getAlpha()) === 1
          );
        });
        if (complete) {
          break;
        }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!complete || uiFinished === null || uiResults === null) {
        throw new Error('Original UI check did not finish');
      }
      return onMain(() => {
        const resources = app.getResources();
        const view = Java.cast(
          activity.findViewById(resources.getIdentifier('isRootedTextView', 'id', sample.package)),
          Java.use('android.widget.TextView')
        );
        const expected = resources.getIdentifier(
          uiFinished ? 'result_rooted' : 'result_not_rooted',
          'string',
          sample.package
        );
        return {
          pid: Process.id,
          checks: uiResults,
          rooted: uiFinished,
          text: String(view.getText()),
          expectedText: String(app.getString(expected)),
          visible: Boolean(view.isShown()),
          tags: String(Java.use('android.os.Build').TAGS.value),
        };
      });
    },
    disposeobserver() {
      return performOnJava(() => {
        for (const method of observers.splice(0)) {
          method.implementation = null;
        }
        return { restored: true };
      });
    },
  };

  return () => {
    rpc.exports = previous;
  };
}
