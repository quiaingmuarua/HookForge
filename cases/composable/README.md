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
work; omitting the pair reads the existing local `dist/android-api.js` (build it
first). Drivers install with `-r`, verify bytes
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

## Linked CLI real APK proof

After `npm ci`, `npm run build:prod` and `npm link` in HookForge, run this from
your separate project directory. Use native Windows Git Bash, not WSL:

```bash
node /d/code_project/geekrun/HookForge/cases/composable/linked.mjs \
  --serial emulator-5554 \
  --rootbeer-apk /d/code_project/geekrun/HookForge/.runtime/fixtures/rootbeer-sample-0.9.apk \
  --duck-apk /d/code_project/geekrun/HookForge/.runtime/fixtures/detect-env-api33-x86_64.apk
```

The API33 x86_64 emulator and locked Frida 17.9.1 server must already be ready.
The driver replaces neither the server nor App data. It installs both supplied
APKs with `-r -t`, checks installed bytes, uses fixed RootBeer identity and checks
Duck SDK/host identity in every original report. Optional `--output` must be new;
default evidence is the caller's `.runtime/frida/cases/local-link/<run-id>`.

This driver executes the real linked command, not `openComposition`, Frida or
direct RPC. Each CLI run has a 22-second duration after readiness. RootBeer
runs observe and root replacement through original UI taps, then rechecks the
same process after each stop and a cold process. A managed read-only adapter
reports original results without changing them. Its observe run also exercises
the caller's default tool output directory.

Duck runs observe, risk and normal as independent CLI runs and triggers one
original `system_properties` HTTP scan per run. Each stop is followed by two
same-PID scans; a final no-Script cold scan checks restoration. A caller-owned
App declaration starts the original NativeActivity and waits for the real main
UI/HTTP. Caller-owned profiles, a selected extension and a separate managed
script load; a declared unselected extension must not load. The original four
properties, three SDK API sources, Critical reduction, unrelated content and
recovery remain required. No whole-device safety claim is made.

`result.json` / `report.md` summarize App acceptance. Each run's own `result.json`
separately reports CLI readiness, installed APIs, actual hashes and cleanup;
`events.jsonl` retains periodic and final API batches. Original UI XML/screenshots,
HTTP responses and JSON/Full Reports remain in the evidence directory. The same
public bundle is used without rebuilding or changing its modification time.

Local verification on 2026-10-29 (API33 x86_64, Frida 17.9.1) passed through
the linked executable from AgentForge:

| Original result | Baseline / observe | Replacement | After unload / cold |
| --- | --- | --- | --- |
| RootBeer UI | Rooted: TestKeys and Dangerous Props | Not rooted; all twelve checks false | Rooted again |
| Duck system_properties Critical | 7 / 7 | Risk 8; normal 4 | 7 on every recheck |

Duck remained DANGER; these counts describe this run only. All four configured
properties had actual Java, getprop and native SDK evidence. RootBeer's default
native result was negative and is not counted as a native bypass.
