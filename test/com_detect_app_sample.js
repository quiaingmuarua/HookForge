
function getClassWrapper(klass) {
    for (const loader of Java.enumerateClassLoadersSync()) {
        try {
            loader.findClass(klass);
            return Java.ClassFactory.get(loader).use(klass);
        } catch (e) {
            // ignore and continue
            continue;
        }
    }
    throw new Error(`${klass} not found`);
}





function main() {

    const ActivityThread = Java.use("android.app.ActivityThread");
    const app = ActivityThread.currentApplication();
    if (app !== null) {
            console.log("Delayed Context: " + app.getApplicationContext());
           const context=app.getApplicationContext();
           const SettingPropInfoCollect = getClassWrapper("com.detect.app.sample.fingerprint_detect.unique_fingerprint.SettingPropInfoCollect");

            console.log(SettingPropInfoCollect);
        console.log(SettingPropInfoCollect.getAllInfo(context));

        } else {
            console.log("Still null… try hooking Application.onCreate");
        }



}

setTimeout(main,2000);


