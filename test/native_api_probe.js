setImmediate(() => {
  const moduleType = typeof Module;
  const interceptorType = typeof Interceptor;
  const memoryType = typeof Memory;
  const moduleKeys =
    moduleType === 'undefined' ? [] : Object.getOwnPropertyNames(Module).sort();

  console.log(`[NATIVE] Module type=${moduleType}`);
  console.log(`[NATIVE] Interceptor type=${interceptorType}`);
  console.log(`[NATIVE] Memory type=${memoryType}`);
  console.log(`[NATIVE] Module keys=${moduleKeys.join(',')}`);

  try {
    const findExport = Module.findExportByName;
    console.log(`[NATIVE] typeof Module.findExportByName=${typeof findExport}`);
  } catch (e) {
    console.log(`[NATIVE] probe failed: ${e}`);
  }
});
