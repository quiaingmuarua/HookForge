# HookForge

Use HookForge to investigate real APKs, write hooks and deliver an actual
result for user acceptance. Reuse its existing capabilities when helpful;
a standalone target script is also a valid starting point.

## Start with a target

Keep project-specific scripts and a short README in your own project.
This repository keeps reusable integration examples under `apps/<sample>/`.
Record the sample version/hash, device, command, observed effect and remaining
limits. Decompiled source and run output belong under the repository `.runtime/`.

For a standalone JavaScript script, use the installed Frida CLI directly:

```bash
frida -D <device-id> -f <package> -l apps/<sample>/hook.js
```

No App manifest or module registration is needed for that path. Choose the
Java bridge appropriate to the host; bundled workspace code uses the shared
bridge described in [Frida 17 notes](docs/FRIDA_17_MIGRATION.md).

The agent owns analysis, implementation, runs and troubleshooting; the user
accepts the actual result. Shared capabilities are extracted from repeated
sample use. Target-specific interventions must not be presented as general
API coverage. See [agent rules](CLAUDE.md).

## Compose existing capabilities

Build and link the local tool once (Windows Git Bash, native Windows Node/ADB):

```bash
npm ci
npm run build:prod
npm link

# Run from your sample/project directory, outside HookForge:
af-frida list
af-frida plan --replace root,system-properties --trace file-io,system-properties
af-frida run --serial emulator-5554 --spawn com.scottyab.rootbeer.sample --replace root --trace file-io,system-properties
```

Run the first three commands in the HookForge checkout. `npm link` registers
that local checkout; no registry publication or login is needed. Rebuild after
source changes without relinking. `npm run cli -- ...` uses the same built Node
Host. Node is pinned in `.node-version`. The GitHub repository is public;
`private: true` in package.json deliberately prevents npm registry publication.

To inspect the link, use `command -v af-frida`, `npm prefix -g` and
`npm ls -g hookforge --depth=0`. If the configured Windows npm prefix is absent
from Git Bash's PATH, add it for the current shell with
`export PATH="$(cygpath -u "$(npm prefix -g)"):$PATH"`. No system PATH change is
made by HookForge. Remove the global link with `npm unlink -g hookforge`.
If a Node consumer also needs a project-local link, run
`npm link hookforge --no-save` there, and remove it with
`npm unlink hookforge --no-save`; this slice provides a CLI, not a Node SDK.

- `list` reports exact API scope. `plan` is offline and executes no App startup
  or extension code. `run` enables only selected capabilities.
- `--trace` and `--replace` accept repeated flags and comma lists. Trace does
  not enable replacement. `--profile` supplies policy values; `--replace`
  supplies intent. Root expands its existing preset. Explicit profile values
  resolve conflicts; plans retain rule sources.
- Select exactly one target: `--spawn <package>`, `--attach <package|pid>` or
  `--app <manifest>`. `--serial` is required for run.
- `build-fields` supports explicit replacement of standard Build string fields
  via `rules.buildFields`; it has no implicit profile or field-read trace claim.
  Combine it with `system-properties` for matching property values.
- Local capabilities use `--extension <manifest>`; managed scripts use
  `--script <entry.ts>`. Both use `activate(ctx) -> cleanup`. Naked scripts
  belong to the direct Frida CLI path above.
- CLI paths resolve from the caller's directory (`INIT_CWD` for npm); manifest
  entries resolve from their manifest directory.
- `--output` must be new; default output is the calling project's
  `.runtime/frida/runs/<run-id>`, not the HookForge installation.
  Runs stay in the foreground; Ctrl+C cleans up. `--duration-ms` starts after
  readiness. Startup defaults to 60 seconds (`--timeout-ms`).
- The host borrows the current device/server and does not create an emulator,
  clear App data or replace a running server.
- Paired `--agent <js> --production-manifest <json>` uses verified public
  production bytes with managed extensions. Without the pair, run reads the
  existing `dist/android-api.js` from HookForge and never rebuilds it. A missing
  bundle fails before device work with the build command. Selected managed
  extensions are still compiled for each run. Plans, actual script bytes/hashes,
  API batches in `events.jsonl`, and cleanup are saved in the calling project.
- Exit 0 means clean stop, 1 execution/observation/cleanup failure, 2 invalid
  input. A clean stop or no hook hits does not establish detector success.
  `original` describes this API layer; use a separate no-intervention baseline.

See [Script Integration Guide](docs/SCRIPT_INTEGRATION_GUIDE.md) for App startup,
extensions, legacy modules and recipes. Duck and Reveny App packs enable no
implicit replacement.

## Existing real-sample cases

| Case | Current purpose |
| --- | --- |
| [RootBeer](cases/rootbeer/README.md) | Shared API effects through original UI; optional same-bundle detect-env reuse |
| [Duck properties](cases/duck-system-properties/README.md) | Original SDK callers through Java, getprop and native property callbacks |
| [Composable CLI](cases/composable/README.md) | Existing cases through CLI selection and managed App extensions |
| [Linked CLI](cases/composable/README.md#linked-cli-real-apk-proof) | Actual npm-linked executable from an external project, RootBeer UI and Duck HTTP changes and recovery |
| [Duck Build/profile](cases/duck-build-profile/README.md) | Combined Build/property effects, inconsistent control and recovery |
| [Reveny properties](cases/reveny-system-properties/README.md) | Original first scan with early native property hooks and cache-aware recovery |

For example, with the locked matching server and API33 x86_64 device ready:

```powershell
npm run case:rootbeer -- --apk <rootbeer.apk> --serial emulator-5554 --reuse-detect-env
```

`--reuse-detect-env` requires the installed project App. Case guides define
exact samples, preparation and limits. Existing cases are regressions and
bounded behavior evidence; a new sample does not need a generic case runner.

## Existing loader and recipe tools

Positional/recipe/smoke entries retain their current behavior:

```powershell
npm run build:prod
node dist/node-cli/run.js --smoke --timeout-ms 75000 -s -c configs/targets/baseline.json <package>
npm run recipe:network-observe
```

The baseline config initializes readiness without hooks. Legacy default target
configs can enable additional modules; their defaults are not inherited by
the composable `run` command. Recipe output can also mirror to
`.runtime/analysis/dynamic`. See the integration guide for those contracts.

## Checks and operations

Use [Testing Strategy](docs/TESTING_STRATEGY.md) for relevant local checks and
the existing two CI proof scopes. Host/unit success does not establish actual
target behavior. Existing production builds, artifact hashes, bridge patch
checks and Linux/macOS device gates retain their contracts.

- [API33 preparation and replay](test/api33/README.md)
- [macOS ARM64 runner](docs/MACOS_RUNNER.md)
- [Event format](docs/EVENT_SCHEMA.md)
- [Agent rules](CLAUDE.md)
- [Independent CI and AgentForge integration](docs/CI.md)
