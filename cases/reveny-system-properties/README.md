# Reveny native property migration

This local case exercises the original APK's automatic first scan through the
composable CLI's App pack/session. Intervention follows the canonical
[Detection Intervention Contract](../../AGENTS.md#detection-intervention-contract).
It proves five standard native property inputs, not a complete emulator bypass.
The SDK, JNI detector, cached findings, UI and APK bytes are unchanged.

## Fixed sample and preparation

`catalog.mjs` is the single source of sample identity: upstream
`reveny/Android-Emulator-Detection`, tag `v1.5.0`, commit
`6443b933e5aa3fbd44215acbf69835c1c4cce4c1`, official APK asset
`emulator-detection-demo-v1.5.0.apk`, SHA256
`9f064f3968e9a224612810ec2b6078872f479930ce4dd0fc1f7132b08c6b3f5b`. Its upstream
source/license is available at the pinned
[repository](https://github.com/reveny/Android-Emulator-Detection/tree/6443b933e5aa3fbd44215acbf69835c1c4cce4c1).
No APK, SDK or native library is copied into committed source.

From the repository root in Git Bash, with native Windows Node/ADB and the
locked API33 x86_64 / Frida 17.9.1 server ready:

```bash
gh release download v1.5.0 --repo reveny/Android-Emulator-Detection \
  --pattern emulator-detection-demo-v1.5.0.apk --dir .runtime/frida/fixtures/reveny
npm run build:hosts
npm run build:prod
npm run artifact:write
npm run case:reveny-system-properties -- \
  --apk .runtime/frida/fixtures/reveny/emulator-detection-demo-v1.5.0.apk \
  --serial emulator-5554 \
  --agent dist/android-api.js \
  --production-manifest .runtime/frida-api33/production-manifest.json
```

The runner verifies the sample before device work and installs with `-r`,
checking the installed APK hash, version and ABI. Signature conflicts fail; it
does not uninstall or clear data. Production arguments are paired and verify the
existing manifest before device operations. Omitting both builds locally.
`--output` must be a new directory; default evidence lives under
`.runtime/cases/reveny-system-properties/<run-id>`.

## Experiment and proof limits

Five existing properties use ordinary `rules.properties`: build product,
manufacturer, bootloader, device and hardware. `risk.json` uses known positive
inputs; `normal.json` uses explicitly synthetic AgentForge strings. Both keep
the real Android version and x86_64 ABI. A naturally negative property branch is
not counted as bypassing an original positive.

Baseline and final cold phases start the original MainActivity without a Script.
Observe/risk/normal each spawn a fresh process, install native hooks before
resume, and retain original SDK calls and the automatic original UI result. The
five inputs must actually be read through `__system_property_get` from
`libemulatordetector.so`; the independent standard-API control RPC is excluded
from SDK coverage. Early trace batches are retained with their timestamps and
the native readiness receipt. Public bundle bytes must be identical across
phases; complete injection hashes are recorded per configuration.

After the first scan, each instrumented phase returns to observe mode and reads
standard native APIs, then repeats those controls after dispose and before
Script unload. The read-only control endpoint owns no hooks and remains until
unload. Original UI/PID are checked after unload. A cached risk conclusion may
remain: restoration of API values and recovery of original detector findings in
a fresh process are separate evidence. No detector cache is cleared or patched.

`result.json` / `acceptance-result.json` preserve phases, lifecycle errors,
cleanup and the Host verdict. Each phase saves original UI text/XML/screenshots,
Logcat, API observations and separate controls; `report.md` compares the five
processes. Missing/invalid evidence, SDK source mismatch, lost events, failed
input delivery, unchanged risk/normal findings or restoration failure returns
nonzero. Exit 2 is an input error; execution/proof/cleanup failures return 1.

This is local device evidence, not a new CI gate. Reuse the same public
production bundle for existing Duck Build/profile and RootBeer + detect-env
regressions. No AAR integration, CPU/file-content concealment, raw-property-area
change, syscall intervention or workflow/matrix change is included.
