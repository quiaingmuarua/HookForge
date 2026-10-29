# Composable CLI device acceptance

These thin drivers use the new parser, App startup and session implementation.
They do not install/connect/inject through a second Host. All commands run
from the repository root with native Windows tools in Git Bash (or CI's
original platform). Prepare the API33 x86_64 device and pinned 17.9.1 server.

```bash
npm run build:hosts
npm run build:prod
npm run artifact:write
npm run case:composable -- \
  --apk .runtime/fixtures/detect-env-api33-x86_64.apk \
  --serial emulator-5554 \
  --agent dist/android-api.js \
  --production-manifest .runtime/frida-api33/production-manifest.json \
  --output .runtime/frida/runs/duck-production
node cases/composable/rootbeer.mjs \
  --apk 'D:/work_app/telegram/RootBeer Sample_0.9_APKPure.apk' \
  --serial emulator-5554 \
  --agent dist/android-api.js \
  --production-manifest .runtime/frida-api33/production-manifest.json \
  --output .runtime/frida/runs/rootbeer-production
```

Use a fresh output directory each time. Production validation precedes device
work; omitting the pair builds locally. Drivers install with `-r`, verify bytes
and never clear App data. RootBeer retains the pinned fixture identity. Duck
records the supplied build's actual APK hash and the original SDK identity.

Duck runs baseline without a Script, observe, risk, normal, restored, two
same-PID post-unload scans and cold. It reuses the existing four-property policy,
controls, original report parser and strict three-source evaluator. The App
subscriber cannot satisfy SDK coverage. UI/HTTP/Full Report content is unchanged.
`acceptance-result.json` owns the detector verdict and `report.md` its table;
`result.json` separately reports tool lifecycle. Each stage retains original
HTTP, JSON/text and separate control/API records. Expected errors in ordinary
control commands remain ordinary App exceptions, not instrumentation failures.

RootBeer combines `root,system-properties` and traces files/properties. A managed
read-only adapter observes the same original UI methods as the existing case;
ADB taps its own repeat control. Baseline, normal and restored retain all rows,
the original aggregate and screenshots. The default native-negative result is
not a native bypass proof. The unchanged RootBeer + detect-env runner remains
the full shared regression, including controlled native coverage and post-unload
UI checks; rerun it with these exact public production bytes.

Both local runs have demonstrated original behavior changes and restoration:
RootBeer rooted → not rooted → rooted; Duck's selected properties change all
three real SDK sources and reduce Critical from risk to normal while its other
findings can remain DANGER. Counts are observations, never a fixed score or a
whole-device safety claim. Evidence stays in `.runtime`; this adds no CI lane.
