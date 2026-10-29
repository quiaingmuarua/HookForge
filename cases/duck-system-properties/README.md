# Duck system-properties: shared API behavior

This case exercises the original locked Duck SDK inside detect-env through its
existing local HTTP event. It proves four configured property inputs across
Java reflection, a real getprop process and native libc callbacks, then checks
the original SDK report and recovery. The intervention boundary is the
[Detection Intervention Contract](../../CLAUDE.md#detection-intervention-contract).

## Inputs and command

Use API33 x86_64 with the running, hash-verified `agentforge-frida-server` from
the current [API33 toolchain](../../test/api33/README.md#环境准备). Node is pinned
by `frida/.node-version`. The runner requires the locked client/server and does
not start an emulator, replace a running server or clear app data.

From the repository root:

```powershell
python -m agentforge_tools release resolve --component worker-sdk
python -m agentforge_tools duck-sdk resolve
.\gradlew.bat :crackme:detect-env:assembleDebug
npm run build:prod
npm run artifact:write
npm run case:duck-system-properties -- `
  --apk ".runtime/fixtures/detect-env-api33-x86_64.apk" `
  --serial emulator-5554 `
  --agent "dist/android-api.js" `
  --production-manifest ".runtime/frida-api33/production-manifest.json"
```

The production manifest must belong to this checkout and Node toolchain. The
case verifies all manifest artifacts and the supplied API bytes before ADB
operations. It never rebuilds a supplied bundle. Omit both production arguments
for a local API build. Relative arguments use the npm caller's directory;
direct `node run.mjs` uses the current directory.

`--apk` and `--serial` are mandatory. `--output <new-directory>` is optional;
even an empty existing directory is refused. APK identity is checked after
`adb install -r`; a signature conflict fails without uninstalling or clearing
data. The installed hash and actual scan SDK identity must match the inputs.
SDK coordinates and AAR SHA256 come exclusively from detect-env's existing
`test/api33/fixture.json`; an external APK keeps its own recorded hash.

## Experiment

The shared implementation is `packages/modules/android-runtime-bypass`.
Configurations contain property names and values only:

| Property | risk | normal |
| --- | --- | --- |
| ro.debuggable | 1 | 0 |
| ro.secure | 0 | 1 |
| ro.adb.secure | 0 | 1 |
| service.adb.root | 1 | 0 |

Every stage POSTs `{"detectorIds":["system_properties"]}` to
`/events/extension.worker.detect-env.duck.scan:call` on device port 5566.
The runner uses its own ephemeral HTTP and Frida forwards. It starts through
the original NativeActivity and waits for the resumed real main Activity.

1. `baseline`: fresh original SDK scan, no injected script.
2. `observe`: pass-through API observations.
3. `risk`: all four inputs aligned to the risk profile.
4. `normal`: all four inputs aligned to the normal profile.
5. `restored`: return to pass-through and compare with baseline.
6. `after-unload-1/2`: dispose, unload and detach; two original scans in the
   same main process without a bridge or script.
7. `cold`: a fresh NativeActivity launch and original scan, without injection.

Each scan has a new ID. Scan requests have a 300-second timeout and are never
automatically retried: a timeout does not establish execution absence.

A supplemental probe shares the public bundle's bridge in the same Script.
It checks the target identity, unrelated property/default/file/package access,
stdout/stderr and exit 7 through both command APIs, and missing-command errors.
Its observations are drained separately before the SDK scan. It calls no Duck
method; its hits cannot satisfy the SDK caller check.

## Results and acceptance

The output is `.runtime/cases/duck-system-properties/<run-id>`:

- `result.json`, `report.md`, `run.log`, `events.jsonl`;
- exact public and complete injected scripts, their hashes, policies and the
  verified production manifest snapshot;
- per-stage original `http-response.json`, result-object `report.json`, exact
  `report.txt`, API observations and separate controls.

The Host requires actual SDK reflection stacks, `ProcessBuilder.start` getprop
and property find/read callbacks from `libduckdetector.so`. All four values must
agree across those sources. A ProcessBuilder hit alone is insufficient: its
real exit code and delivered values are checked. Observe mode does not consume
or wrap the original process output.

The original Core rows must show the configured values and the SDK's original
Critical count must decrease from risk to normal. Source mismatches, reduced
key-source coverage, changed unrelated static content, missing/duplicate rows,
errors or dropped observations fail. Restoration compares semantic properties,
counts and static report content, retaining timestamps, PID, scan IDs and
diagnostic property-area mtimes separately.

The initial API33/x86_64 experiment observed Critical `7 → 8 → 4 → 7` for
baseline/risk/normal/restored; both post-unload scans and cold startup returned
to 7. These are observed counts, not hardcoded pass thresholds. All stages
remained DANGER because other original findings remain.

The JSON and Full Report retain their original SDK integration-baseline format.
Experiment phases and intervention verdicts are Host-owned. Build fields,
raw property areas, boot parameters, JVM fallback and other native property
interfaces are outside this intervention claim; available/unavailable outcomes
remain visible. No system property is written or changed device-wide.

Only successful behavior evaluation and resource cleanup return 0. Failures
retain available evidence and return nonzero. Cleanup removes this run's
scripts, sessions and forwards; an unsafe callback shutdown stops the owned
test process before unloading and remains a failed run.

This is a local real-device experiment, not an additional CI gate. Existing
RootBeer + detect-env UI proof must still pass with the same production API
bundle. The current CI proof scopes and job contracts remain unchanged.
