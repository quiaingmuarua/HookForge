# Testing Strategy

This is the canonical Frida verification guide. Shared API acceptance follows
the [Detection Intervention Contract](../CLAUDE.md#detection-intervention-contract).
CI separates runtime mechanisms from shared API behavior; passing one does not
establish the other.

## Local Work

Select verification by the change and the current experiment:

| Change | Useful local check |
| --- | --- |
| Logging, config or documentation | Run the affected command or inspect the changed content |
| Target-specific Hook or recipe | Run the target and inspect the intended behavior and relevant output |
| Shared Android API hook | Observe real APK calls, configure positive/negative API values, verify its own result and restoration; reuse unchanged implementation on another APK |
| Shared Java bridge, loader or host | Relevant unit tests, build and the affected attach/spawn smoke |
| Toolchain or API 33 runner | Tool tests and the affected real emulator cases |

During exploration, retain the sample identity, environment, command, script
and useful before/after observations. Move stable, frequently repeated cases
into CI as they become valuable. A new experiment does not need a scenario
protocol or a general-purpose verifier before it can be useful.

The user's requested App outcome is the sample task's acceptance goal. The
agent owns analysis, hook implementation, runs and troubleshooting; the user
performs final acceptance. Standalone scripts, target-specific hooks and useful
text logs are valid deliverables. Report their intervention layer and limits;
they do not automatically establish shared API behavior. Existing public
capability cases and CI keep their stronger reuse and restoration requirements.

The RootBeer case separates API call coverage from the effect of configured values. Normal
UI actions use ADB input; invoking detector methods or performClick from an
agent is not accepted as natural native-call coverage. The same public bundle
and profiles are additionally exercised through detect-env's existing UI.
See `cases/rootbeer/README.md`. Temporary probes are supplemental evidence.

The local [Duck system-properties case](../cases/duck-system-properties/README.md)
uses the existing SDK scan HTTP event. It checks four property inputs across
original reflection, ProcessBuilder getprop and native callback calls, then
the original SDK Critical count and semantic recovery. Separate controls never
count as SDK coverage. The same process must survive two post-unload scans;
cold startup has a new PID. Its production bytes and original JSON/text are
retained under `.runtime/cases/duck-system-properties`. This case is not
yet a CI gate; the automated proof scopes below remain unchanged. Retain the
existing RootBeer + detect-env regression with the same public bundle when
changing these shared hooks.

## Two Proof Scopes

The local [Reveny case](../cases/reveny-system-properties/README.md) exercises
the original v1.5.0 APK's first automatic scan. It checks pre-resume native
readiness, actual `libemulatordetector.so` getter calls, five constructed property
findings, standard-API restoration and fresh-process detector recovery.
Positive findings are cached by that SDK: a same-PID UI that retains its first
result is not a failed API restore. Separate controls cannot count as SDK calls.
The real x86/CPU/file findings remain. This adds no CI gate; use the same public
production bundle for Duck Build/profile and RootBeer + detect-env regressions.

### Composable CLI local acceptance

`npm run case:composable -- --apk <detect-env.apk> --serial
<serial> [--agent <js> --production-manifest <json>] [--output <new-directory>]`
runs the existing Duck eight-phase verdict through the new CLI parser, App
pack, target preparation and session implementation. It saves
`acceptance-result.json` (detector verdict), `result.json` (tool lifecycle), each
original JSON/Full Report and separate control/API evidence. App observer
events cannot stand in for the evaluator's SDK caller checks.

`node cases/composable/rootbeer.mjs --apk <fixed-rootbeer.apk> --serial
<serial>` checks the new `root,system-properties` composition using the original
RootBeer UI. It retains baseline/normal/restored results and screenshots. Use
the same optional production pair for both commands, then run the unchanged
RootBeer + detect-env case with that public bundle as the shared regression.
These local experiments add no workflow or job and do not change CI proof
classification. They do not claim full Duck/emulator/syscall coverage.

Windows runs use Git Bash with native Windows Node/Python/ADB and the Windows
emulator; WSL is unnecessary. Run `test_prepare.py`, `test_run.py` and
`test_suite.py` with native unittest, alongside all Node checks. The existing
POSIX emulator process-lifecycle tests in `test_emulator.py` run on their CI
platform, not as a prerequisite for the Windows CLI.

| Scope | Evidence | What a pass establishes |
| --- | --- | --- |
| Runtime mechanisms | Four Python/Node × attach/spawn cases in `summary.json` | Frida interception, RPC, loader readiness and cleanup work in the controlled environment |
| Shared API behavior | RootBeer + detect-env case in `rootbeer/result.json` | The same public API bundle and policies affect original APK results and restore them afterwards |

The Java/JNI mechanism probes deliberately replace test-App methods. They
remain useful mechanism regressions, but do not count as reusable detector
intervention. Source review checks that delivered intervention respects the
canonical contract; a report classification is not an attestation of that fact.

Pinned, open-source detection APKs with fixed identity and hash can be stable
behavior gates. RootBeer is such a fixture; detect-env is built from the current
checkout and its installed hash is recorded per run. Updating either requires
reviewing the relevant original detection paths and expected behavior.

Apps with changing releases, live services or account prerequisites remain
exploration/manual validation targets. Prefer weak semantic event assertions
over exact event counts, timing, URLs or device identifiers for those targets.

## Automated Gates

`npm run test:ci` runs source types, separate unit-test/agent types, source lint,
Node unit tests, Python toolchain tests, generated-host consistency and a
development build. It needs Node from `.node-version` and Python 3.10+; CI pins
Python 3.11. `API33_PYTHON` can select the tool-test interpreter on either OS.

`npm run build:prod` creates `dist/bundle.js`, `dist/android-api.js` and `dist/node-cli/*.js` without
overwriting committed development hosts. `artifact:write` and `artifact:verify`
carry/check exact production bytes between the host and emulator jobs.

The dependent API 33 CI job first runs four controlled-target mechanism cases:

| Host | Launch modes | Acceptance |
| --- | --- | --- |
| Python probes | attach, spawn | libc/JNI/Java original → hooked → restored values, hook callbacks, RPC JSON/async/error transport, cleanup |
| Production Node CLI | attach, spawn | same uploaded production bytes, loader-ready, required module activation, no agent/loader errors, cleanup; verbose spawn |

After those pass, the same emulator runs the original RootBeer UI and detect-env
UI against the uploaded public API bundle. The fixed RootBeer test Release is
downloaded read-only and checked against the case's SHA256. Observe, configured
positive/negative values, restoration, cold startup and post-unload UI checks
remain separate evidence. The same public bytes and profiles must reach both APKs.

The case consumes `--agent` and `--production-manifest` without rebuilding the
public hook, and writes under the API33 run's `rootbeer` directory. CI passes
`--case-result` to the report; missing, invalid, failed, locally rebuilt or
single-APK-only evidence fails the report and job even if the base suite is green.
Base-only local reporting remains available by omitting `--case-result`.

Ubuntu retains the x86_64 two-job workflow. The AgentForge-owned Mac ARM64 integration workflow
runs Host checks and both device scopes in one job, with `--abi arm64-v8a` passed
to preparation, suite, RootBeer and reporting. The schema-2 toolchain lock maps
Android ABI to the corresponding Frida server/process architecture and exact
server hashes. Actual device/process architecture and the selected lock entry
are evidence, not inferred from the host CPU. A result for one ABI does not
establish the other. The Mac report also requires ownership-aware emulator
cleanup via `--cleanup-result`; setup and operations are in
[Mac runner operations](MACOS_RUNNER.md).

`job-result.json` preserves `status`, `suite`, `rootbeer` when requested, and
step failures. Its additive `proofs` projection contains:

- `runtimeMechanisms`: `passed`/`failed`, with the `summary.json` result path.
- `sharedApiBehavior`: `passed`/`failed`/`missing`/`not-requested`, with the case
  result path and public API SHA256; the path/hash are null when not requested.

Actions Summary displays both scopes and the original App comparison. Only
the case Host interprets detector behavior; Python projects its verdict. An
empty detect-env findings map is valid negative evidence. Missing maps, invalid
markers, API errors and incomplete restoration fail acceptance. Direct syscall
observations are shown separately and are not claimed as covered by libc hooks.

CI requires both scopes to pass and initialization/execution/cleanup steps to
succeed. A local base-only report can succeed with shared behavior explicitly
`not-requested`; it proves mechanisms only. Missing or malformed required case
evidence cannot be replaced by successful mechanism probes.

Markdown-only changes skip the HookForge workflow; mixed changes and manual
dispatch run both jobs. The fixed detect-env APK comes from this repository's
test Release; no AgentForge source or Android build is required. See
[Independent CI](CI.md) for fixtures and optional consumer integration.

An available VM alone does not mean the Application ClassLoader is ready.
The loader and Java test agent share `initializeJavaClassLoader`, which probes
framework classes with `Java.performNow` before queuing `Java.perform` work.
This covers spawn-time initialization and avoids waiting indefinitely on the
bridge's deferred app-loader callback.

Smoke success requires readiness and all requested `--require-module` and
`--require-recipe` statuses. Timeout, activation failure, script/loader error,
structured runtime errors, unexpected detach or cleanup failure return nonzero even with `--verbose`.
Use `--result FILE` for machine-readable outcomes/messages/cleanup. See
`test/api33/README.md` for environment preparation and complete replay commands.

## Layer 1: CI-safe unit tests

CI runs these on related pull requests. During local work, select the relevant
tests and broaden the run when shared behavior changes:

- selector and matching logic
- target config shape checks
- pure helper logic
- host-side argument parsing or formatting logic when decoupled enough

These tests do not need a device.

## Layer 2: module contract tests

Run these in CI when practical:

- module activation against mocked `Java`, `Module`, `Interceptor`, or `send`
- expected skip behavior when runtime capabilities are unavailable
- expected message or log emission
- weak semantic event-contract checks against fixture JSONL

These should validate a module contract, not the whole Android runtime.

## Layer 3: device integration tests

Run these on a connected device, emulator, or self-hosted runner:

- attach or spawn against `crackme:detect-env`
- spoof validation against DetectApp target flows
- system-app smoke tests such as calculator, browser, or messaging targets

This layer validates real runtime behavior and timing.

## Recommended Target Roles

- `crackme:detect-env`
  Primary integration target for anti-Frida, fingerprint, spoofing, and validation work.

- system apps
  Secondary smoke targets for stable attach or spawn validation and generic tracing.

## Baseline CI Command

The local [Duck Build/profile case](../cases/duck-build-profile/README.md) adds
selected main-process Build/property composition evidence. It uses the existing
App startup/session and original dual-detector HTTP reports, checks actual
three-source property calls, a deliberately inconsistent configuration, original
Build findings and restoration after unload/cold start. Field readback alone is
not behavior acceptance. Remaining virtualization findings are preserved. This
case adds no CI job or automatic Duck gate; shared API changes still require
the existing RootBeer + detect-env regression with the same public bytes.

Use this as the default GitHub Actions gate for the workspace:

```bash
npm.cmd run test:ci
```

The exact host checks and the two device proof scopes are described above.
This command alone does not execute device acceptance.

## Device Regression Command

Use this when validating DetectApp behavior on a device:

```bash
npm.cmd run test:device:detectapp
```

## Smoke Targets

Use these for quick device-level sanity checks before debugging a specific module:

```bash
npm.cmd run test:smoke:messages
npm.cmd run test:smoke:settings
npm.cmd run test:smoke:detectapp
npm.cmd run test:smoke:detectapp:passive
npm.cmd run test:node:smoke:settings:spawn
npm.cmd run test:node:smoke:settings:frontmost
npm.cmd run test:node:probe:java
```

Recommended usage:

- `messages` or `settings`
  baseline smoke targets for Frida connectivity and basic Java availability
- `test:node:smoke:settings:spawn`
  validates the Node host spawn path and bundle injection lifecycle
- `test:node:smoke:settings:frontmost`
  validates the Node host attach path against the current foreground app
- `test:node:probe:java`
  validates whether Node-driven `createScript()` exposes the Android Java bridge at all
- `detectapp`
  stronger crackme-oriented target with more timing sensitivity
- `detectapp:passive`
  lowest-impact attach check for DetectApp when active probing is unstable
- `--dump-events`
  stores structured `trace-event` output under `output/normalized/` for later agent analysis

## Frida 17 Regression Triage

When a future Frida upgrade breaks Android behavior, debug in this order:

1. CLI smoke

```bash
npm.cmd run test:smoke:settings
```

2. Node host smoke

```bash
npm.cmd run test:node:smoke:settings:spawn
npm.cmd run test:node:smoke:settings:frontmost
```

3. Node Java bridge probe

```bash
npm.cmd run test:node:probe:java
```

4. Shared API behavior through the original App UI

```bash
npm.cmd run case:rootbeer -- --apk "D:\work_app\telegram\RootBeer Sample_0.9_APKPure.apk" --serial emulator-5554 --reuse-detect-env
```

Interpretation:

- if CLI smoke fails, fix Frida environment or device/server issues first
- if CLI smoke passes but Node host selects zero Java modules, suspect bridge
  exposure instead of module selection first
- if Node probe shows missing global `Java`, do not patch modules back to raw
  global access; inspect `packages/core/java-bridge.ts` and read
  `docs/FRIDA_17_MIGRATION.md`
- if base smoke passes but the real case fails, inspect its API callers,
  configured values and original UI results before changing the shared hooks
