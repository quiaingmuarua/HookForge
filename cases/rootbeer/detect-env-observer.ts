// Reuse witness only: open an existing screen, click its row, read the real dialog.
import { initializeJavaClassLoader, Java, performOnJava } from '../../packages/runtime/java-bridge';
import { waitForSensitiveFilesTap } from './detect-env-readiness';

const packageName = 'com.detect.app.sample';
const activityName = `${packageName}.risk_detect.RiskDetectionActivity`;
let app: any;
let activity: any;
let dialog: any = null;
const observers: any[] = [];

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

rpc.exports = {
  ...rpc.exports,
  async init() {
    if (!(await initializeJavaClassLoader(15000))) {
      throw new Error('detect-env Application ClassLoader not ready');
    }
    const info = await performOnJava(() => {
      app = Java.use('android.app.ActivityThread').currentApplication();
      const showDialog = Java.use('android.app.Dialog').show.overload();
      showDialog.implementation = function (this: any) {
        const result = showDialog.call(this);
        if (String(this.getContext().getPackageName()) === packageName) {
          dialog = Java.retain(this);
        }
        return result;
      };
      observers.push(showDialog);
      return {
        package: String(app.getPackageName()),
        version: String(app.getPackageManager().getPackageInfo(packageName, 0).versionName.value),
        sdk: Number(Java.use('android.os.Build$VERSION').SDK_INT.value),
        arch: Process.arch,
      };
    });
    // The SDK NativeActivity performs early collection before redirecting to
    // this screen. Opening RiskDetectionActivity earlier lets that redirect
    // cover it before its RecyclerView lays out.
    let host: any = null;
    let hostReady = false;
    const launchDeadline = Date.now() + 15000;
    while (!hostReady && Date.now() < launchDeadline) {
      if (host === null) {
        await performOnJava(
          () =>
            new Promise<void>(resolve => {
              Java.choose(`${packageName}.DetectEnvMainActivity`, {
                onMatch(value: any) {
                  if (!value.isFinishing() && !value.isDestroyed()) {
                    host = Java.retain(value);
                    return 'stop';
                  }
                  return undefined;
                },
                onComplete() {
                  resolve();
                },
              });
            })
        );
      }
      if (host !== null) {
        hostReady = await onMain(() => !host.isDestroyed() && host.hasWindowFocus());
        if (!hostReady && host.isDestroyed()) {
          host = null;
        }
      }
      if (!hostReady) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!hostReady) {
      throw new Error('detect-env SDK launch did not reach its focused main screen');
    }
    await onMain(() => {
      const intent = Java.use('android.content.Intent').$new();
      intent.setClassName(packageName, activityName).addFlags(0x10000000);
      app.startActivity(intent);
    });
    const deadline = Date.now() + 15000;
    while (!activity && Date.now() < deadline) {
      await performOnJava(
        () =>
          new Promise<void>(resolve =>
            Java.choose(activityName, {
              onMatch(value: any) {
                if (!value.isFinishing() && !value.isDestroyed()) {
                  activity = Java.retain(value);
                  return 'stop';
                }
                return undefined;
              },
              onComplete() {
                resolve();
              },
            })
          )
      );
      if (!activity) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    if (!activity) {
      throw new Error('detect-env risk screen not ready');
    }
    while (Date.now() < deadline) {
      const ready = await onMain(
        () => activity.recyclerView.value.findViewHolderForAdapterPosition(0) !== null
      );
      if (ready) {
        return info;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error('detect-env sensitive-files row did not finish layout');
  },
  async prepareui() {
    await onMain(() => {
      if (dialog !== null && dialog.isShowing()) {
        dialog.dismiss();
      }
      dialog = null;
    });
    return waitForSensitiveFilesTap(() =>
      onMain(() => {
        const window = activity.getWindow();
        const holder = activity.recyclerView.value.findViewHolderForAdapterPosition(0);
        if (window === null || holder === null || activity.isFinishing()) {
          return null;
        }
        const row = Java.cast(holder.itemView.value, Java.use('android.view.View'));
        const rect = Java.use('android.graphics.Rect').$new();
        const visible = Boolean(row.getLocalVisibleRect(rect));
        const location = Java.array('int', [0, 0]);
        row.getLocationOnScreen(location);
        return {
          activityFocused: Boolean(activity.hasWindowFocus()),
          windowFocused: Boolean(window.getDecorView().hasWindowFocus()),
          attached: Boolean(row.isAttachedToWindow()),
          shown: Boolean(row.isShown()),
          enabled: Boolean(row.isEnabled()),
          bounds: visible
            ? {
                left: Number(location[0]) + Number(rect.left.value),
                top: Number(location[1]) + Number(rect.top.value),
                right: Number(location[0]) + Number(rect.right.value),
                bottom: Number(location[1]) + Number(rect.bottom.value),
              }
            : null,
        };
      })
    );
  },
  async ui() {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (await onMain(() => dialog !== null && dialog.isShowing())) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return onMain(() => {
      if (dialog === null || !dialog.isShowing()) {
        throw new Error('Original file-check UI action did not show its result dialog');
      }
      const EditText = Java.use('android.widget.EditText');
      const ViewGroup = Java.use('android.view.ViewGroup');
      function findText(view: any): string | null {
        if (EditText.class.isInstance(view)) {
          const editable = Java.cast(
            Java.cast(view, EditText).getText(),
            Java.use('java.lang.Object')
          );
          return String(editable.toString());
        }
        if (ViewGroup.class.isInstance(view)) {
          const group = Java.cast(view, ViewGroup);
          for (let index = 0; index < group.getChildCount(); index++) {
            const found = findText(group.getChildAt(index));
            if (found !== null) {
              return found;
            }
          }
        }
        return null;
      }
      const text = findText(dialog.getWindow().getDecorView());
      if (text === null) {
        throw new Error('Original file-check result text is missing');
      }
      return { pid: Process.id, result: JSON.parse(text), visible: true, text };
    });
  },
  disposeobserver() {
    return onMain(() => {
      for (const method of observers.splice(0)) {
        method.implementation = null;
      }
      if (dialog !== null && dialog.isShowing()) {
        dialog.dismiss();
      }
      return { restored: true };
    });
  },
};
