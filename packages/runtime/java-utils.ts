import { Java, isJavaAvailable } from './java-bridge';

export function getJavaClass(className: string, raise = false): any {
  if (!isJavaAvailable()) {
    if (raise) {
      throw new Error(`Java bridge not available while resolving class: ${className}`);
    }
    return null;
  }

  for (const loader of Java.enumerateClassLoadersSync()) {
    try {
      loader.findClass(className);
      return Java.ClassFactory.get(loader).use(className);
    } catch {
      continue;
    }
  }

  try {
    return Java.use(className);
  } catch {
    if (raise) {
      throw new Error(`Java class not found: ${className}`);
    }
    return null;
  }
}

export function safeGetJavaClass(
  className: string,
  logger?: (_msg: string, ..._args: any[]) => void
): any {
  try {
    const javaClass = getJavaClass(className, false);
    if (!javaClass && logger) {
      logger(`Failed to find Java class: ${className}`);
    }
    return javaClass;
  } catch (error) {
    if (logger) {
      logger(`Error getting Java class ${className}: ${error}`);
    }
    return null;
  }
}

export function getJavaClasses(classNames: string[], raise = false): Record<string, any> {
  const result: Record<string, any> = {};
  const missing: string[] = [];

  for (const className of classNames) {
    const javaClass = getJavaClass(className, false);
    if (javaClass) {
      result[className] = javaClass;
    } else {
      missing.push(className);
    }
  }

  if (raise && missing.length > 0) {
    throw new Error(`Java classes not found: ${missing.join(', ')}`);
  }

  return result;
}

export function hasJavaClass(className: string): boolean {
  return getJavaClass(className, false) !== null;
}
