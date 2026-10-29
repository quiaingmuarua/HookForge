# Android Device Profile

This retained legacy loader family contains `info-collector.ts`,
`sim-collector.ts`, `device-fingerprint.ts` and `build-spoof.ts`.
These strategies collect App-visible information and implement the specific
replacements below. A declared configuration type is not proof of an installed
hook or a consistent whole-device identity.

For reversible standard Build fields and system-property composition, use
the public capabilities described in the [workspace README](../../../README.md).
The legacy file-based configuration below belongs to the positional loader;
it is not the composable CLI's `--profile` format.

All commands below run from the **repository root**. The `npm --prefix frida`
commands run their scripts inside `frida/`, so legacy config paths passed to
those scripts are relative to that directory.

## Fingerprint collection

Use the Node version and dependency setup in the workspace README. The legacy
collector needs the generated host and loader bundle:

```powershell
npm run build
npm run fingerprint:manual -- com.example.app
npm run fingerprint:manual -- com.example.app --spawn
```

Replace `com.example.app` with an installed target; the attach form requires a
running process (a process name can also be supplied). These are alternative
attach/spawn commands. They require an accessible Frida device and Java runtime.
`npm run fingerprint` is the optional automatic selector: it
looks for running Settings, Chrome or Messages, then falls back to spawning
`com.android.calculator2`. That package is not present on every device.

The wrapper uses `configs/targets/fingerprint.json`. Its relevant flags are:

| Flag | Effect |
| --- | --- |
| `fingerprint.outputFile` | Filename beneath `output/`; null or omitted uses `device_fingerprint_<timestamp>.json`. Use a filename, not an absolute output directory. |
| `fingerprint.autoSave` | Saves through a host `save_file` message unless explicitly false. |
| `host.exitOnCollectionComplete` | When true, the legacy host starts cleanup and exits on `collection_complete` outside smoke mode. It does not impose a fixed completion time. |

With the commands above, JSON is saved on the **host** under
`frida/output/device_fingerprint_<timestamp>.json`, not on the Android device.
The host resolves `output/` against its working directory; calling
`node hosts/node-cli/run.js` directly from the repository root would
instead write under the root `output/` directory.

The result groups values under `device_info`, `sim_info` and `collection_info`.
Collection reads what the target process can access. Android restrictions,
target App permissions, available services and API differences can leave
fields empty or unavailable. A completion message does not establish that all
identifiers were collected. Check the host's `[FILE] Saved`/`[FILE] Failed`
message and the actual JSON; the collector's own save log only means it sent
the request.

## Existing file-based configuration

`UniversalSpoofManager` tries these readable device paths in order and caches
the loaded configuration for the script lifetime:

1. `/data/local/tmp/device_fingerprint.json`
2. `/sdcard/device_fingerprint.json`
3. `/storage/emulated/0/device_fingerprint.json`
4. `/data/local/tmp/spoof_config.json`
5. `/sdcard/spoof_config.json`

Example for the implemented SIM getter hooks:

```json
{
  "sim_info": {
    "simOperator": "31000",
    "simOperatorName": "Lab",
    "simCountryIso": "us",
    "networkOperator": "31000",
    "networkOperatorName": "Lab",
    "networkCountryIso": "us",
    "simSerialNumber": "8901260123456789012",
    "subscriberId": "310260123456789",
    "line1Number": "+15551234567",
    "carrierId": 1234,
    "specificCarrierId": 1234
  }
}
```

Save those data as `spoof_config.json` in the repository root, then make the
file readable to the target App at one of the paths above, for example:

```powershell
adb push spoof_config.json /data/local/tmp/device_fingerprint.json
```

A separate legacy target config selects the strategy:

```json
{
  "enable": ["sim"],
  "flags": {
    "sim.enableSpoofing": true,
    "sim.logInfo": true
  }
}
```

The existing `configs/targets/sim-spoofing.json` selects these flags:

```powershell
npm run cli -- -c configs/targets/sim-spoofing.json com.example.app
```

The host target config selects modules and flags; the JSON pushed to the device
supplies replacement values. Pushing a file does not ensure the target App can
read it. Check target-process access and valid JSON, and reload the script after
changing a device file because the configuration is cached.
Only present SIM values are replaced. The current SIM hook list does not
implement every field declared in `DeviceSpoofConfig`, including IMEI.

## Existing Build strategy

Select `build-spoof` in the legacy target config and set
`build.enableSpoofing: true`; `build.logInfo` controls its logging.
The device file's `device_info` maps:

- `brand/manufacturer/model/device/product/hardware/board/fingerprint` to the
  corresponding Build string fields.
- `bootloader/build_id/android_version` to BOOTLOADER, ID and VERSION.RELEASE.
- `api_level` and `security_patch` to VERSION.SDK_INT and VERSION.SECURITY_PATCH.
- `android_id` to the Settings.Secure string getter's `android_id` result.

The legacy Build setter uses empty strings for omitted ordinary string fields
when `device_info` exists, so supply the intended complete values for this
path. Its behavior is separate from the public reversible `build-fields`
owner and should not inherit that owner's proof claims. Location, network,
sensor and hardware fields in configuration types do not establish matching
hooks in this family.

## Troubleshooting

- For connection or target errors, inspect `adb devices` and `frida-ps -U`,
  confirm the chosen target is running or installed, and check the configured
  Frida transport/server. Automatic target selection is only a convenience.
- For missing fields, inspect collection errors and the target's permissions
  and services. A different process may expose different values; its results
  do not prove access from the original target.
- To inspect host messages or reduce selected loader modules, use one of:

  ```powershell
  npm run cli -- -v -c configs/targets/fingerprint.json com.example.app
  npm run cli -- -v -c configs/targets/fingerprint-simple.json com.example.app
  ```

  The simple config still runs the fingerprint collector; it does not bypass
  permission restrictions or promise faster completion.
- For unchanged SIM/Build values, check the selected strategy, its enable flag,
  the loaded device file and whether the target calls a supported API. Hook
  installation logs alone do not establish the target's final behavior.

Keep sample outcomes and unsupported methods explicit. New target work can
remain in `apps/<sample>`; extend this family only when actual reuse calls
for these existing strategies.
