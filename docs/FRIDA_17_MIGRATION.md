# Frida 17 Migration Notes

This note focuses specifically on Android Java access, native API drift, and
Node-hosted bundle behavior in this workspace. It is not a complete summary of
every Frida 17 breaking change.

This document captures the main breakage we hit while moving the `frida/`
workspace from the older Frida 16 assumptions to Frida 17 runtime behavior.

Use this file first when:

- Node host injection suddenly stops activating Java-based modules
- CLI scripts work, but `hosts/node-cli/run.js` selects zero Java modules
- a future Frida upgrade changes how Android Java bridge access is exposed

## Short Version

The key migration lesson is:

- Frida CLI on Android still exposes a usable global `Java`
- Node-hosted `session.createScript()` bundles should not assume global `Java`
- Node-hosted bundles must access Java through a facade backed by
  `frida-java-bridge`

The workspace now enforces that rule through:

- `packages/core/java-bridge.ts`
- `packages/core/env.ts`
- `packages/core/java-utils.ts`
- `packages/loader/index.ts`

## Before vs After

### Before

The older code assumed Android Java access looked like this everywhere:

```ts
if (typeof Java !== 'undefined' && Java.available) {
  Java.perform(() => {
    const ActivityThread = Java.use('android.app.ActivityThread');
  });
}
```

This worked reliably in CLI-injected scripts, but it was not a safe assumption
for Node-hosted bundles under Frida 17.

### After

The current code uses an explicit facade:

```ts
import { Java, isJavaAvailable, performOnJava } from '../core/java-bridge';

if (isJavaAvailable()) {
  await performOnJava(() => {
    const ActivityThread = Java.use('android.app.ActivityThread');
  });
}
```

This keeps module code independent from whether `Java` was injected globally by
the runtime.

## Symptoms We Saw

The migration issue surfaced with a confusing split:

- `frida -U/-Uf/-UF -l script.js` worked on-device
- `node hosts/node-cli/run.js ...` connected, attached, and loaded the bundle
- but Java-dependent modules did not activate

Observed symptoms included:

- `Java available: false`
- `Selected 0 modules: (none)`
- probe output showing `hasJavaGlobal=false`
- Node host smoke tests succeeding at transport level but failing at Java-level

This made the issue look like a loader or timing bug at first, but the core
problem was earlier in the stack.

## Root Cause

Under our Frida 17 Node path:

- transport and script loading worked
- the Android Java bridge was not exposed as `globalThis.Java`
- waiting longer did not fix that by itself

We confirmed that:

- CLI path still had usable global `Java`
- explicit `import Java from 'frida-java-bridge'` worked in Node-created bundles

So the real fix was not "wait longer for Java", but "stop depending on global
Java in Node-injected bundles".

## Fix Applied

### 1. Upgrade runtime dependencies

The Node workspace was upgraded from Frida 16-era assumptions to Frida 17-era
dependencies:

- `frida`: `^17.4.0`
- `frida-java-bridge`: `^7.0.13`

### 2. Introduce a Java facade

`packages/core/java-bridge.ts` is now the only supported entry point for Java
bridge access inside the bundled agent.

It provides:

- `Java`
- `isJavaAvailable()`
- `performOnJava()`

### 3. Migrate shared runtime helpers

These core files were migrated away from global `Java` assumptions:

- `packages/core/env.ts`
- `packages/core/java-utils.ts`
- `packages/loader/index.ts`

### 4. Migrate Android modules

Android capability modules were updated to use `performOnJava()` and the facade
instead of raw global `Java`.

That change affected:

- `android/runtime-bypass`
- `android/device-profile`
- `android/network-observe`
- `android/validation`

### 5. Adjust Frida 17 native API assumptions

One follow-up breakage showed up in `android/runtime-bypass`.

Older assumptions expected:

- `Module.findExportByName('libc.so', 'fopen')`

But on the current Frida 17 runtime we verified that:

- `Module.findExportByName` is not present
- global export lookup is exposed through `findGlobalExportByName` or
  `getGlobalExportByName`

The native root bypass path now resolves exports through that Frida 17 shape
instead of assuming the older static helper still exists.

### 6. Tighten SIM fallback merge rules

`android/device-profile` also needed a data-quality fix during the migration.

We saw a split where:

- TelephonyManager returned useful SIM values such as `simCountryIso=ca`
- system properties returned lower-quality placeholders such as `","` or
  unrelated fallback values

The collector now treats system-property SIM values as fallback-only:

- they only fill empty fields
- they do not overwrite TelephonyManager results
- placeholder strings such as `","` are ignored

## Validation Commands

Use these commands in order when debugging a future Frida upgrade.

### Step 1: verify CLI path

```bash
npm.cmd run test:smoke:settings
```

If this fails, the problem is not specific to the Node host.

### Step 2: verify Node host transport path

```bash
npm.cmd run test:node:smoke:settings:spawn
npm.cmd run test:node:smoke:settings:frontmost
```

If these fail before loader logs appear, check Frida client/server compatibility
and host-side attach or spawn flow first.

### Step 3: verify Java bridge exposure in Node

```bash
npm.cmd run test:node:probe:java
```

If this shows missing global Java but the facade path still works, do not
rewrite modules back to global `Java`.

### Step 4: verify workspace health

```bash
npm.cmd run type-check
npm.cmd run build
npm.cmd run test:unit
```

### Step 5: verify native hook path

```bash
npm.cmd run case:rootbeer -- --apk "D:\work_app\telegram\RootBeer Sample_0.9_APKPure.apk" --serial emulator-5554 --reuse-detect-env
```

This observes actual APK callers and verifies configured positive/negative
Java file and libc `fopen` behavior through the original RootBeer and detect-env
interfaces, including restoration. Native export lookup or a private self-probe
alone does not establish that the shared hook affects an APK.

## Operational Guidance For Agents

When editing Android-focused Frida modules in this workspace:

- do not assume `globalThis.Java` exists
- do not gate Android support on raw `typeof Java !== 'undefined'`
- use `packages/core/java-bridge.ts`
- prefer `performOnJava()` over ad-hoc Java scheduling
- treat CLI success and Node host success as separate validation layers

## Known Runtime Notes

- `frontmost attach` is a better first smoke target for Java-heavy debugging
  when early `spawn` timing is noisy
- `com.android.settings` is the preferred first Android Node smoke target
- `crackme:detect-env` is more timing-sensitive and should not be the first
  target used to debug host or bridge regressions
- native API shape may drift separately from Java bridge behavior, so treat
  native hook regressions as a separate verification path
- SIM fallback values from system properties are lower trust than
  TelephonyManager results

## If Frida 18+ Breaks Again

Debug in this order:

1. confirm CLI still works
2. confirm Node host transport still works
3. check whether global `Java` disappeared or changed shape
4. update only the facade layer first
5. avoid mass rewrites in individual modules until the facade is confirmed

The goal is to keep future upgrades localized to the bridge boundary instead of
spreading version-specific assumptions across every hook module.
