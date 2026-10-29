export function isNativeRuntimeAvailable(): boolean {
  return (
    typeof Module !== 'undefined' &&
    typeof Interceptor !== 'undefined' &&
    typeof Memory !== 'undefined'
  );
}

export function resolveExportByName(name: string): NativePointer | null {
  if (typeof Module === 'undefined') {
    return null;
  }

  const moduleApi = Module as any;

  if (typeof moduleApi.findGlobalExportByName === 'function') {
    return moduleApi.findGlobalExportByName(name);
  }

  if (typeof moduleApi.getGlobalExportByName === 'function') {
    try {
      return moduleApi.getGlobalExportByName(name);
    } catch {
      return null;
    }
  }

  if (typeof moduleApi.findExportByName === 'function') {
    return moduleApi.findExportByName(null, name);
  }

  return null;
}
