# Frida Java bridge patch

`frida-java-bridge-7.0.13.patch.json` contains the exact replacement and source/output
SHA256 values for the pinned npm package. Its npm archive URL and SHA512 integrity
match `package-lock.json`; the original `lib/android.js` hash was verified against
that archive.

The patch synchronizes registered ART replacement methods immediately after
`notifyArtMethodHooked()` installs instrumentation. When the Nterp entry point is
available, it flushes pending Interceptor changes before synchronizing the quick
entry point. This reconciles an Nterp entry published between the original method
snapshot and instrumentation setup, the window observed in API 33 ARM64 spawn
tests. It adds no delay, retry, detector-specific rule or deoptimization.

`npm ci` applies the patch through `postinstall`. `npm run check:bridge-patch`
verifies the installed bytes without changing them, and `build:prod` runs that
check before building. The installer accepts only the exact official source or
the exact reviewed patched bytes. A different version, lock identity or file
hash fails instead of applying a best-effort patch. Re-running the installer on
patched bytes leaves the file unchanged.

The upstream package remains version 7.0.13 and retains its upstream license
(`LGPL-2.0 WITH WxWindows-exception-3.1`). Frida client/server versions are unchanged.
