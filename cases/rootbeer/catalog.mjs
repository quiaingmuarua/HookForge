export const sample = {
  package: 'com.scottyab.rootbeer.sample',
  version: '0.9',
  sha256: 'cf1ad3c3c7f5dff2da91f72527b7756b658dc711408359173606cfce5fe08f0f',
  fixture: {
    repository: 'quiaingmuarua/HookForge',
    tag: 'frida-fixtures-rootbeer-0.9',
    asset: 'rootbeer-sample-0.9.apk',
  },
};

// Order and labels come from this APK's CheckForRootWorker.getRootResults().
export const checks = [
  { id: 'rootManagement', label: 'Root Management Apps', method: 'detectRootManagementApps' },
  {
    id: 'dangerousApps',
    label: 'Potentially Dangerous Apps',
    method: 'detectPotentiallyDangerousApps',
  },
  { id: 'cloaking', label: 'Root Cloaking Apps', method: 'detectRootCloakingApps' },
  { id: 'testKeys', label: 'TestKeys', method: 'detectTestKeys' },
  { id: 'busybox', label: 'BusyBoxBinary', method: 'checkForBusyBoxBinary' },
  { id: 'suBinary', label: 'SU Binary', method: 'checkForSuBinary' },
  { id: 'suWhich', label: '2nd SU Binary check', method: 'checkSuExists' },
  { id: 'rwPaths', label: 'For RW Paths', method: 'checkForRWPaths' },
  { id: 'dangerousProps', label: 'Dangerous Props', method: 'checkForDangerousProps' },
  { id: 'nativeRoot', label: 'Root via native check', method: 'checkForRootNative' },
  { id: 'selinux', label: 'SE linux Flag Is Enabled', method: 'isSelinuxFlagInEnabled' },
  { id: 'magisk', label: 'Magisk specific checks', method: 'checkForMagiskBinary' },
];
