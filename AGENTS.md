# HookForge working guide

HookForge supports real Android dynamic-analysis tasks. Judge its value by
problems solved and repeated investigation/debugging saved. Adding scripts,
modules or passing CI alone does not establish that value.

Read [README.md](README.md), then the nearest sample or owner needed for the
task. This is a standalone tool repository with no Gradle build. Read other
guides when the task needs them.

## Default work loop

1. Establish the real target and requested outcome. Inspect existing work,
   available tools and prior solutions, then use decompilation, source searches
   and runtime observation to locate the relevant behavior.
2. Prefer a suitable existing tool or script. Running it successfully and
   delivering reproducible commands, actual results and limits is a complete
   outcome, even with no new HookForge code. Using a third-party tool does not
   require wrapping it in a HookForge adapter.
3. Write a targeted hook or minimal adaptation for an observed gap. Standalone
   scripts and target-specific solutions are valid; they need no manifest,
   registry entry or generic verifier. Keep private/project-specific work in
   its consuming project. Only public integration examples belong in
   `apps/<sample>/` here.
4. Own execution and troubleshooting through to a reproducible result or a
   concrete blocker. Record sample version/hash, tool versions, environment,
   command and configuration, actual observations and limits. Useful text logs
   suffice during exploration. The user performs final acceptance; mark untested claims.
5. Extract shared code when repeated real use shows a useful common mechanism.
   Well-understood common operations can have lightweight helpers. Identify
   what work the code saves before adding it; do not duplicate mature tools or
   build orchestration, analysis or tool-routing frameworks in anticipation.

Use an existing HookForge capability when it helps. Its managed CLI is optional
for sample work; selecting it retains the `activate(ctx) -> cleanup` contract.
Its `--script` option does not accept naked Frida scripts. See the
[Script Integration Guide](docs/SCRIPT_INTEGRATION_GUIDE.md).

## Git and verification

- Commit routine, scoped changes directly to `main`. Use a branch and PR for
  major changes such as substantial runtime/API changes or broad refactoring.
  Inspect the current branch and worktree first, preserve existing work and
  branch choices, and do not create a new branch for every task.
- HookForge evolves independently. AgentForge pins an explicit submodule commit
  and upgrades when needed; do not automatically change the consumer repository.
- Choose the closest verification: actual target behavior for sample work;
  relevant tests, build and affected attach/spawn smoke for shared runtime
  changes; links and command ownership for documentation. Broaden checks for
  changed behavior, not to turn each task into a CI or lifecycle project.
- Existing public capability cases retain their reuse and restoration checks.
  See [Testing Strategy](docs/TESTING_STRATEGY.md) and [CI](docs/CI.md). A script
  loading or an API being hit alone does not prove the requested App outcome.
- Use Windows Git Bash and native Windows tools locally; do not use WSL.

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

RootBeer/detect-env, Duck and Reveny retain their specific acceptance contracts.
Exploration need not complete every public capability gate before a solution
can be useful.

## Ownership and source rules

- `apps/<sample>/`: public integration examples, special startup and usage.
  Private/project-specific scripts stay with their consumer, such as
  AgentForge's `frida-projects/`.
- `cases/`: existing repeatable target acceptance and read-only adapters.
- `packages/modules/`: reusable runtime behavior; `packages/runtime/` and
  `packages/core/`: bridges and helpers; `packages/events/`: normalized output.
- `hosts/node-cli/`: host execution. Edit TypeScript and regenerate checked-in
  development JavaScript with `npm run build:hosts`.
- Existing recipes, configs and registries retain their execution paths;
  registration is not required for every new experiment.
- `api-hooks.ts` and `api-runtime.ts` under `packages/modules/android-runtime-bypass`
  own the shared system APIs. Managed subscribers reuse that instance instead
  of installing competing hooks.
- External App/SDK source stays with its owner. Local external inputs use
  `third_party_readonly/`; cache, builds and evidence use the working project's
  `.runtime/`. Preserve unrelated work, original samples and local evidence;
  keep APKs, AARs, downloaded tools and real traffic out of Git. Do not search
  parent directories for an AgentForge checkout. Preserve
  `.runtime/analysis/dynamic`, used by existing recipes.
- Bundled Java code uses the shared Java bridge and `performOnJava`; Node
  bundles cannot assume a global Java bridge. See
  [Frida 17 notes](docs/FRIDA_17_MIGRATION.md).
- Shared hooks clean up owned resources, including native callbacks. Retain
  activation/deactivation and strict-mode behavior for Stalker/qBDI and other
  stateful engines. Sample work needs cleanup appropriate to its side effects.

Node is pinned in `.node-version`. `npm ci` applies the reviewed Java bridge
patch; keep install lifecycle scripts enabled. `npm run check:bridge-patch`
verifies the installed bytes. Existing CI keeps type/lint/unit/tool checks,
generated-host consistency, production validation and documented device proofs.

- [Script integration](docs/SCRIPT_INTEGRATION_GUIDE.md)
- [Event format](docs/EVENT_SCHEMA.md)
- [API33 replay](test/api33/README.md)
- [Mac runner operations](docs/MACOS_RUNNER.md)
