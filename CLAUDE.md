# HookForge agent guide

This repository owns injected scripts, hook capabilities, sample hosts and
Node tooling. It runs independently of AgentForge and has no Gradle build.
Start with [usage and samples](README.md), then the relevant source or sample
README. Read additional guides only when the task needs them.

## Default work loop

1. Take the supplied APK and the user's acceptance goal. Inspect existing work
   and tool availability, then use decompilation, source searches, native
   analysis and dynamic observation to locate the relevant behavior.
2. Write and run hooks; investigate failures through to a reproducible App
   outcome or specific blocker. A loaded script or a new API wrapper alone
   does not complete the task.
3. Keep new target scripts and a short README in `apps/<sample>/`. Standalone
   scripts and target-specific hooks are valid deliverables. They can use the
   Frida CLI directly, without a manifest, registry entry or generic verifier.
4. Record sample version/hash, environment, command, script/config, actual
   observations and limits. Useful text logs are sufficient during exploration.
   The user performs final acceptance; mark untested claims accordingly.
5. Extract reusable mechanisms when another real task benefits from them.
   Experiments may retain target parameters and duplication until that need
   exists. Do not create general string-decryption or control-flow frameworks
   before a working sample solution.

Use an existing capability when it helps. Adoption of the managed CLI is
optional for sample work; when selected, its `activate(ctx) -> cleanup` contract
still applies. Its `--script` option does not accept naked Frida scripts.
See [Script Integration Guide](docs/SCRIPT_INTEGRATION_GUIDE.md).

## Detection Intervention Contract

This contract applies when delivering or claiming **shared API behavior**.
Target-specific solutions can satisfy a user's sample goal, but must be labeled
as target-specific and cannot be counted as this public capability proof.

- Shared intervention belongs in Java/framework, system-property or native
  system APIs. Change the inputs consumed by the original detector and let
  its own logic produce the result.
- Shared acceptance must not replace detector methods or target JNI detection
  returns, edit results, alter detection flow or change displayed conclusions.
- Public hooks must not choose outcomes by detector class, target JNI symbol
  or caller identity. Paths, property names, commands, values and standard
  fields are valid policy inputs; caller identity is observation evidence.
- Cases may trigger targets and interpret original results. Read-only
  observation preserves original arguments, returns, exceptions and behavior.
- Establish actual APK callers, configured effects, recovery and unchanged
  implementation reuse on another APK before claiming reusable coverage.
  Independent probes and controlled Java/JNI replacements prove mechanisms only.
- Retain unsupported paths, including direct syscalls, as explicit limits.
  A target-specific workaround does not extend shared API coverage.

Existing RootBeer/detect-env, Duck and Reveny cases retain their specific
acceptance contracts. The [Testing Strategy](docs/TESTING_STRATEGY.md) remains
the source for existing CI scopes; exploration is not required to complete
every public capability gate before a script can be useful.

## Ownership and source rules

- `apps/<sample>/`: public integration examples, special startup and usage.
- `cases/`: existing repeatable target acceptance and read-only adapters.
- `packages/modules/`: reusable runtime behavior.
- `packages/runtime/` and `packages/core/`: shared bridges and helpers.
- `packages/events/`: event format for consumers that need normalized data.
- `hosts/node-cli/`: attach/spawn and host execution. Edit TypeScript sources;
  generated JavaScript belongs to `npm run build:hosts`.
- Existing `packages/recipes`, configs and registries keep their established
  execution paths; they are not mandatory steps for every new experiment.
- The public system API owner is `api-hooks.ts` plus `api-runtime.ts` under
  `packages/modules/android-runtime-bypass`. Managed subscribers reuse that
  instance rather than installing a competing hook.
- External App/SDK source remains with its owning project. Keep local samples
  in `third_party_readonly/`, downloads and evidence in this repository's
  `.runtime/`. Do not search the parent directory for an AgentForge checkout.
  Preserve `.runtime/analysis/dynamic`, used by existing recipe output.
- Bundled Java code uses the repository Java bridge and `performOnJava`.
  Do not assume Node bundles have a global Java bridge. See
  [Frida 17 notes](docs/FRIDA_17_MIGRATION.md) for actual host differences.
- Stable shared hooks must clean up their resources. For Stalker/qBDI and other
  stateful shared engines, retain activation/deactivation and strict-mode
  behavior. Sample work needs cleanup appropriate to its actual side effects.

## Verification

Choose the closest check: actual target behavior for a sample script; affected
tests and attach/spawn smoke for shared runtime changes; documentation and
commands for a documentation edit. Broaden only for changed behavior.
Do not turn a sample task into an unrelated lifecycle, schema or CI project.

The workspace pins Node in `.node-version`. `npm ci` installs dependencies and
applies the reviewed Java bridge patch; do not disable install lifecycle scripts.
`npm run check:bridge-patch` verifies the installed bytes.
Existing shared CI still runs type/lint/unit/tool checks, generated-host
consistency, production artifact validation and the documented device proofs.

- [Testing Strategy](docs/TESTING_STRATEGY.md): checks and acceptance boundaries.
- [Script Integration Guide](docs/SCRIPT_INTEGRATION_GUIDE.md): current contracts.
- [Event Schema](docs/EVENT_SCHEMA.md): structured output when needed.
- [API33 replay](test/api33/README.md): device preparation and repeatable runs.
- [Mac runner operations](docs/MACOS_RUNNER.md): isolated ARM64 runner setup.
