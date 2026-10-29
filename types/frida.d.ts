/**
 * Frida TypeScript 类型定义
 * 提供基本的 Frida API 类型支持
 */

declare global {
  // Frida 核心对象
  const Process: {
    id: number;
    platform: 'linux' | 'darwin' | 'windows' | 'android' | 'ios';
    arch: string;
    pageSize: number;
    pointerSize: number;
    codeSigningPolicy: string;
    enumerateModules(): Module[];
    getModuleByName(name: string): Module;
    getCurrentThreadId(): number;
    findModuleByName(name: string): Module | null;
    findModuleByAddress(address: NativePointer): Module | null;
  };

  interface Module {
    name: string;
    base: NativePointer;
    size: number;
    path: string;
    getExportByName(name: string): NativePointer;
    enumerateExports(): ModuleExportDetails[];
    enumerateImports(): ModuleImportDetails[];
    enumerateSymbols(): ModuleSymbolDetails[];
  }

  interface ModuleExportDetails {
    type: 'function' | 'variable';
    name: string;
    address: NativePointer;
  }

  interface ModuleImportDetails {
    type: 'function' | 'variable';
    name: string;
    module: string;
    address: NativePointer;
  }

  interface ModuleSymbolDetails {
    name: string;
    address: NativePointer;
    type: string;
    section?: {
      id: string;
      protection: string;
    };
  }

  // Memory 操作
  const Memory: {
    alloc(size: number): NativePointer;
    allocUtf8String(str: string): NativePointer;
    allocAnsiString(str: string): NativePointer;
    readCString(address: NativePointer): string;
    readUtf8String(address: NativePointer, length?: number): string;
    writeUtf8String(address: NativePointer, str: string): void;
    protect(address: NativePointer, size: number, protection: string): boolean;
  };

  // Native 指针
  interface NativePointer {
    add(offset: number | string): NativePointer;
    sub(offset: number | string): NativePointer;
    isNull(): boolean;
    toString(): string;
    toInt32(): number;
    equals(other: NativePointer): boolean;
    readCString(): string;
  }

  interface NativeFunction {
    (this: any, ...args: any[]): any;
  }

  const NativeFunction: {
    new (
      address: NativePointer,
      retType: string,
      argTypes: string[],
      options?: { exceptions?: 'steal' | 'propagate' }
    ): NativeFunction;
  };

  const NativeCallback: {
    new (callback: (...args: any[]) => void, retType: string, argTypes: string[]): NativePointer;
  };

  // Module 查找
  const Module: {
    findGlobalExportByName(name: string): NativePointer | null;
    getGlobalExportByName(name: string): NativePointer;
    findExportByName(moduleName: string | null, exportName: string): NativePointer | null;
    findBaseAddress(name: string): NativePointer | null;
  };

  // Interceptor
  const Interceptor: {
    attach(
      target: NativePointer,
      callbacks: {
        onEnter?(this: InvocationContext, args: NativePointer[]): void;
        onLeave?(this: InvocationContext, retval: InvocationReturnValue): void;
      }
    ): InvocationListener;
    replace(target: NativePointer, replacement: NativeFunction): void;
    flush(): void;
  };

  interface InvocationContext {
    threadId: number;
    errno: number;
    [key: string]: any;
  }

  interface InvocationReturnValue extends NativePointer {
    replace(value: number | NativePointer): void;
  }

  const rpc: { exports: Record<string, (...args: any[]) => any> };
  const Script: { runtime: string };

  interface InvocationListener {
    detach(): void;
  }

  // Java (Android)
  const Java: {
    available: boolean;
    perform(fn: () => void): void;
    use(className: string): JavaClass;
    enumerateLoadedClasses(): string[];
    enumerateLoadedClassesSync(): string[];
    enumerateClassLoadersSync(): any[];
    ClassFactory: {
      get(loader: any): {
        use(className: string): JavaClass;
      };
    };
    registerClass(spec: {
      name: string;
      implements?: JavaClass[];
      methods?: { [key: string]: (...args: any[]) => any };
    }): JavaClass;
  };

  interface JavaClass {
    $new(...args: any[]): JavaObject;
    $alloc(): JavaObject;
    [methodName: string]: any;
  }

  interface JavaObject {
    $className: string;
    [methodName: string]: any;
  }

  // ObjC (iOS)
  const ObjC: {
    available: boolean;
    classes: { [className: string]: ObjCClass };
    protocols: { [protocolName: string]: any };
    Object: new (handle: any) => any;
  };

  interface ObjCClass {
    $className: string;
    $protocols: any[];
    $methods: string[];
    $ownMethods: string[];
    [methodName: string]: any;
  }

  // 消息传递
  function send(message: any, data?: ArrayBuffer): void;
  function recv(type: string, callback: (message: any) => void): void;
  function recv(callback: (message: any) => void): void;

  // 控制台
  const console: {
    log(...args: any[]): void;
    warn(...args: any[]): void;
    error(...args: any[]): void;
  };

  // 定时器
  function setTimeout(callback: () => void, delay: number): any;
  function setInterval(callback: () => void, interval: number): any;
  function clearTimeout(id: any): void;
  function clearInterval(id: any): void;
  function setImmediate(callback: () => void): void;

  // 全局对象扩展
  const globalThis: any;
}

export {};
