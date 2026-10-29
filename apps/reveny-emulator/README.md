# Reveny original APK App pack

This pack targets the original Reveny Emulator Detection v1.5.0 main process. It
selects no replacement values and never calls a detector. The public native
property hooks are prepared in the suspended spawn child before resume; Java
capabilities and managed entries follow exact process verification. An optional
Activity declaration is also passed to Frida's spawn API.

```bash
npm run cli -- plan --app apps/reveny-emulator/app.json --trace system-properties
npm run cli -- run --serial emulator-5554 --app apps/reveny-emulator/app.json --trace system-properties
```

Add
`--replace system-properties --profile cases/reveny-system-properties/risk.json`
or `normal.json` for the five synthetic property inputs. Other findings,
including the real x86 ABI, remain.

`host.mjs` waits for the original MainActivity and nonempty `result_text`. Its
UIAutomator XML file is unique to this run and removed on cleanup. It creates no
Frida session and does not modify UI text. A standard original cold launch
resets this App's task with NEW_TASK/CLEAR_TASK: a browser previously opened
from the sample must not turn a launch into merely bringing that old task to the
front. Application data is retained. A startup failure is saved, never
automatically replayed through another launch mode.

The native detector caches positive findings for the process lifetime. Returning
API policy to observe or unloading a Script does not clear those findings. Use
the [case](../../cases/reveny-system-properties/README.md) for independent
fresh-process comparisons and separate API restoration evidence.
