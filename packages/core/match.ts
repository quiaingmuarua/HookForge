import { Env, ModuleMeta, TargetConfig } from './types';

const matchStr = (val: string | undefined, cond?: string | RegExp) => {
  if (!cond) {
    return true;
  }
  if (!val) {
    return false;
  }
  return typeof cond === 'string' ? val === cond : cond.test(val);
};

export function selectModules(all: ModuleMeta[], env: Env, cfg: TargetConfig) {
  return all
    .filter(module => {
      const selector = module.selector || {};

      if (selector.platform && selector.platform !== env.platform) {
        return false;
      }

      if (!matchStr(env.appId, selector.appId)) {
        return false;
      }

      if (!matchStr(env.appVer, selector.appVer)) {
        return false;
      }

      if (selector.layer) {
        if (selector.layer === 'java' && !env.javaAvailable) {
          return false;
        }
        if (selector.layer === 'objc' && !env.objcAvailable) {
          return false;
        }
      }

      if (selector.predicate && !selector.predicate(env)) {
        return false;
      }

      if (selector.tags && cfg.enable) {
        if (!selector.tags.some(tag => cfg.enable!.includes(tag))) {
          return false;
        }
      }

      return true;
    })
    .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
}
