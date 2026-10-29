# Independent CI and optional AgentForge integration

HookForge is a public, standalone Frida tool. Its clean public baseline comes
from the reviewed pre-publication tool snapshot. Earlier history and
project-specific capture/detection research remain in the private archive and
AgentForge's `frida-projects/`; they are not published through this repository.
APKs, real traffic, device collections and runtime evidence are not Git sources.

## Local commands

Run from the HookForge root using the Node version in `.node-version`:

```bash
npm ci
npm run build:prod
npm run cli -- list
npm run cli -- plan --replace root,system-properties --trace file-io,system-properties
npm run test:ci
npm run build:prod
npm run artifact:write
npm run artifact:verify
```

The `af-frida` bin and existing case/sample commands retain their names. Default
downloads and toolchains belong to this checkout's `.runtime/`. Composable CLI
results belong to the calling project's `.runtime/`. Existing absolute inputs
and caller-relative command arguments remain supported.

## Ubuntu CI

The `frida` job checks source and tools and builds production artifacts. The
dependent `frida-api33` job consumes those exact bytes on API33 x86_64, runs
Python/Node × attach/spawn, then RootBeer with detect-env reuse. Reports retain
separate runtime-mechanism and shared-API proofs; required evidence or cleanup
failure fails the job. Evidence is retained seven days.

Both APKs come from immutable test Releases in this repository, using the job's
read-only `GITHUB_TOKEN`. RootBeer coordinates/hash live in its existing catalog;
detect-env coordinates, hash, package/ABI and clean-build provenance live in
`test/api33/fixture.json`. Download and verify before installing. Releases are
prereleases, never Latest; never overwrite mismatched existing assets.

CI neither checks out AgentForge nor resolves/builds its Worker SDK or Duck AAR.
Refresh detect-env only when its test contract or required capabilities change:
build a clean, recorded AgentForge commit; publish a new test tag/asset; update
the fixture declaration and run both proof scopes. Never select a latest APK.

Markdown-only changes skip CI. Manual dispatch runs both jobs. Tool provenance
always uses the HookForge checkout SHA. Runtime/suite/job report schema 3 uses
`checkoutCommit`; production manifest schema 2 and case schemas remain unchanged.

## AgentForge consumption

AgentForge keeps `frida/` as a submodule pinned to a tested HookForge commit.
Develop HookForge independently; an ordinary new commit does not update that pin
or trigger the consumer CI. Updating AgentForge is an explicit upgrade, not a
per-commit requirement.

The parent retains its Ubuntu integration and trusted macOS ARM64 runner. These
build the parent's current detect-env and use the fixed child tools. The macOS
runner is not registered with HookForge and no ARM64 CI claim is made here.

Pre-publication AgentForge pins continue to use the private archive through a
read-only deploy key. Consuming this public baseline is a separate, explicit
upgrade. Consumers keep their own RootBeer Release mirror where needed;
integration reports distinguish tool SHA from consumer SHA.

Clone/init/update instructions and parent-owned build inputs belong to
AgentForge's build guide. Hooks, sample scripts and independent checks belong here.
