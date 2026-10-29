# Duck Build/property composition

This local device case verifies a synthetic, bounded profile through the
original `system_properties` and `virtualization` SDK scans. The detector can
remain DANGER. It does not prove a physical-device identity, startup/helper
coverage, graphics, raw property-area changes or direct syscall interception.
The
[Detection Intervention Contract](../../CLAUDE.md#detection-intervention-contract)
applies; no SDK detection method or result is replaced.

From the repository root in Git Bash, with native Windows Node/ADB, the
Duck-enabled APK and the locked API33 x86_64 / Frida 17.9.1 server prepared:

```bash
npm run build:hosts
npm run build:prod
npm run artifact:write
npm run case:duck-build-profile -- \
  --apk .runtime/fixtures/detect-env-api33-x86_64.apk \
  --serial emulator-5554 \
  --agent dist/android-api.js \
  --production-manifest .runtime/frida-api33/production-manifest.json
```

Production arguments are paired and verified before device work. Omitting them
builds locally. `--output` must name a new directory; the default is
`.runtime/cases/duck-build-profile/<run-id>`. Install uses `-r` and
verifies the actual bytes, without uninstalling or clearing data. No WSL is
used.

The thin driver uses the composable CLI parser, original Duck App startup and
shared session. It calls only the existing local HTTP scan event with both
detector IDs. Scans are sequential and never replayed after an uncertain HTTP
outcome. SDK, APK, AAR, public, extension and injected-script identities are
retained with each run.

The baseline full fingerprint supplies release/build-ID/incremental. The Host
constructs the AgentForge synthetic profile, preserves real version/ABI fields,
and validates the generated ordinary policies through offline composition.
Missing properties or incomplete fingerprints fail instead of inventing data.
Profiles are case data; public code contains no SDK classes or detector rules.

Phases are baseline without a Script, observe, properties-only, fields-only,
inconsistent (only framework TAGS differs), combined, restored, two same-PID
post-unload scans and cold. The original SDK must report the mismatch control,
then remove it with composition; combined Critical must be lower than
properties-only. Original Build findings must change and restore. The three
actual SDK API sources for type/tags/fingerprint are checked separately from
supplemental probes. Field receipts are mutations and readbacks, never
field-read API traces. Other findings, including Frida-related or dynamic
differences, remain in the full original reports.

After a case, reuse its generated profile for ordinary foreground operation:

```bash
npm run cli -- run \
  --serial emulator-5554 --app apps/detect-env-duck/app.json \
  --replace build-fields,system-properties --trace system-properties \
  --profile <run-directory>/profiles/combined.json
```

Each phase retains `http-response.json`, `report.json`, and unchanged UTF-8
`report.txt`; injected phases additionally retain field receipts, SDK API
observations and separate control observations. `profiles/*.plan.json` records
offline expansion. `result.json` owns tool lifecycle, `acceptance-result.json`
owns Host behavior evaluation, and `report.md` is their readable comparison.
Either execution, behavior or cleanup failure returns nonzero. Evidence and
generated profiles stay in `.runtime`; no new CI gate is added.
