# Script Integration Guide

For a new sample, first check whether an existing tool or previous solution
already achieves the requested outcome. Running that tool and recording its
command, actual result and limits is a complete deliverable; no HookForge
adapter or new script is required. Write a small target-specific script or
adapter only for an observed gap.

A standalone script in your own project can run directly with the Frida CLI;
see [usage](../README.md). Public integration examples belong in `apps/`;
private target research stays in the consuming project. A manifest, recipe or
common module is optional until it helps the actual task.

The composable Node CLI loads managed TypeScript with local manifests.
Its `--script` entry requires `activate(ctx) -> cleanup` and rejects naked
scripts. Do runtime work inside activation, not at import time.
[Detection Intervention Contract](../AGENTS.md#detection-intervention-contract)
applies to shared API acceptance; label target-specific solutions separately.

Build with `npm run build:prod`, then `npm link` in HookForge. From another
project, `af-frida list/plan/run` uses that checkout's built Host and public
agent. Your manifests, profiles and scripts can stay outside HookForge; pass
their paths as arguments. Relative CLI paths and default `.runtime/frida/runs`
output belong to the caller (`INIT_CWD` when invoked through npm). Manifest
entries are relative to the manifest. Only selected managed entries compile;
run does not rebuild the public bundle or write outputs into the tool install.
The paired production artifact options retain their existing verifier.

## Add a public capability

Use this path for a recurring gap demonstrated by real tasks, or a small,
well-understood common operation that is useful to share. Check existing tools
and capabilities first; wrapping a working tool is not itself a reason to add
an extension. The contracts below apply after choosing managed integration.

Create a local manifest, without editing the CLI or legacy module registry:

```json
{
  "id": "lab-files",
  "modes": ["trace", "replace"],
  "groups": ["file-io"],
  "entry": "capability.ts",
  "preset": "normal.json"
}
```

`normal.json` is data in the existing format:

```json
{"mode":"replace","rules":{"fileExists":{"/data/local/tmp/example":false}}}
```

The runtime entry uses the already installed API instance:

```ts
export function activate(ctx) {
  const unsubscribe = ctx.api.subscribe(event => {
    if (event.api === 'java.io.File.exists') {
      ctx.emit('lab-file-call', event);
    }
  });
  return async () => { unsubscribe(); };
}
```

Use `--extension <manifest> --trace lab-files --replace lab-files`. Presets do
not install hooks. Groups are the current shared `file-io`, `system-properties`,
`commands`, `packages`, legacy TAGS `build`, and `build-fields` API sets. Different rules for the same input
conflict unless an explicit profile resolves them; plans retain all sources.

A new API can live in a managed public entry with `groups: []` and
`owns: ["its.canonical.api.id"]`. Before taking the hook, call
`ctx.scope.own(id, cleanup)` and register rollback; return an awaitable cleanup.
Use exact shared identifiers from `packages/composition/ownership.ts` for the
existing owner: these hooks must use shared rules/subscriptions instead of
being taken again. Declared and runtime managed claims reject duplicates.
This does not certify arbitrary script source as conflict-free.

The small context supplies `Java`, `performOnJava`, `log`, `emit`,
`api.policy()` (a copy), `api.subscribe()` and `scope.own/defer`. It does not
create another bridge, session or dependency container. Subscription failures
are recorded as runtime failures without changing the observed call's return
or exception. Register all resources during activation so partial failures
roll back too. Shutdown stops replacement first, then reverses extensions,
restores the shared owner, waits for native callbacks and unloads.

## Add an App

Use an App pack when the task benefits from reusable startup or in-process
integration. A successful standalone experiment can remain in its own project.

An App manifest may be as small as:

```json
{
  "id": "demo-app",
  "package": "com.example.demo",
  "process": "com.example.demo",
  "launch": {"mode":"activity","activity":".MainActivity"},
  "agent": "agent.ts"
}
```

Use `--app <manifest>`. `launch.mode: "spawn"` is also supported. An optional
`host.mjs` may export `launch(ctx)` returning the started target PID and/or
`waitReady(ctx, target)`. It receives ADB, owned forwarding, logging, cancellation,
remaining time and cleanup registration. It must not create its own Frida
session or replay startup/scans. Omit `launch` to retain built-in startup.
The common Host verifies the exact PID/process before activating capabilities;
for suspended Android spawn this happens after resume/specialization.

Apps that detect during startup can opt into `launch.nativeBeforeResume: true`
with built-in spawn. The Host loads one Script into only its newly spawned PID,
waits for internal `preparenative` to install the selected native APIs/policy,
then resumes and verifies the exact process before Java/managed activation.
The default order is unchanged. Such a Host may provide `waitReady`, but cannot
replace `launch`. No selected native APIs is a valid empty preparation, not
detector coverage. Java/class-loader work never blocks native preparation, and
failed/cancelled initialization can clean up without a Java loader.

The [Reveny App pack](../apps/reveny-emulator/README.md) exercises this option.
Its case uses shared `session.launchOriginal()` for no-Script baseline/cold
launches, with the declared Activity. Those results explicitly record
`instrumentation: "none"`. A native property change during startup may be cached
by the App or framework; API restoration does not clear those caches. Verify
fresh-process recovery separately.

The optional `agent.ts` has the same `activate(ctx) -> cleanup` contract as
public entries. Keep business protocol, obfuscated-class discovery, UI receipt
reading and special startup here. App-specific internal hooks are supported,
with ownership and cleanup. Selecting an App enables no implicit replacement.
The [Duck App pack](../apps/detect-env-duck/README.md) is the real example.

## Absorb an App experiment into public capability

Promote the mechanism when repeated real use establishes a shared need, or when
a well-understood common operation benefits from a small helper. Keep the
original command and limits when an existing tool already solves the task.

If an App experiment only changes `SystemProperties.get` values, remove its
direct method replacement. Put the values in a policy JSON and use
`--replace system-properties --profile <json>`. Java getters, getprop and the
native getter/callback then share those values. Leave App startup and read-only result
interpretation in the App/case. A new standard API should get one public owner
and a repeatable real target check before other App code reuses it.

App-specific result replacement remains an App experiment and cannot count as
shared API behavior proof. API-origin observation and original detector results
are separate evidence; private probes do not establish detector coverage.

For standard Build string fields, use `--replace build-fields` with
`rules.buildFields`, alongside `--replace system-properties` for corresponding
property values. No App-specific setter is needed. `buildTags` and
`buildFields.TAGS` target one shared state owner and follow normal conflict
rules. Field receipts are not SDK read-call traces. The
[Duck Build/profile experiment](../cases/duck-build-profile/README.md) demonstrates
why a one-sided configuration can differ from a composed profile, while keeping
the original SDK mismatch findings and Full Report.

## Existing modules and recipes

Existing loader modules retain `meta.activate/deactivate`, target flags and
their current registry. Existing recipes retain their recipe registry. Extend
those owners for changes to existing flows; a new CLI extension needs neither
registry. `focused-runtime` observes its file/property/command points through
the shared API owner instead of competing for the same methods; its other
business/network hooks are outside this migration.

## Runtime owners

- `hosts/node-cli` owns attach/spawn, injection and host output. TypeScript is
  authoritative; generate its JavaScript entries with `npm run build:hosts`.
- `packages/composition` resolves managed lifetime around one public bundle;
  `api-runtime.ts` owns the shared system API instance.
- `packages/runtime` owns Java/native bridges; `packages/events` owns the
  normalized event contract. Bundled Android code imports the shared Java
  bridge and uses `performOnJava`; see [Frida 17 notes](FRIDA_17_MIGRATION.md).
- `packages/loader`, target configs and registries serve the retained legacy
  positional path. They are separate from the composable capability catalog.
- Target App and installed-hook sources stay in their owning external project.
  For example, AgentForge owns its `crackme` and `xposed` modules; these are not
  directories or build prerequisites in the standalone HookForge checkout.

## Retained module and recipe contracts

Existing loader modules use `meta.id`, `meta.selector`, `meta.priority`,
`meta.activate(ctx)` and resource cleanup through `meta.deactivate`.
Selectors describe platform/layer/tags. Target enablement belongs in the
existing target configs. Keep new managed CLI entries out of this registry
unless they actually need the legacy loader.

Existing recipes run through `hosts/node-cli/run-recipe.ts`. Keep lightweight
metadata in `*.meta.ts`, catalog entries in `configs/recipe-registry.ts`
and executable wiring in `configs/recipe-runtime-registry.ts` so discovery
does not import runtime-heavy code. Run presets live in `configs/runs`.
Project-specific recipes and standalone target experiments stay with their
consumer project. Public integration examples in `apps/` need no recipe registration.

`--dump-events` retains normalized output with recipe-start/recipe-finish
events. Audit recipes can mirror to `.runtime/analysis/dynamic`; this remains
a trace output directory. External adapters live under
`packages/recipes/adaptors` with import commands under `scripts/import`.

For output consumed by these existing tools, preserve [Event Schema](EVENT_SCHEMA.md):
stable `point`, method `target`, enter/leave phases when available, thread/process
context and structured errors. This is an interface requirement for normalized
consumers, not a ban on useful text logs in sample experiments.

For network investigation, inspect HTTP request/response/failure events first,
then socket connect and TLS handshake. Installation without hits proves only
installation; socket activity without HTTP events calls for investigation of
the actual lower-level stack.
