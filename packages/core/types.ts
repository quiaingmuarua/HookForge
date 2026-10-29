import type { TraceEvent } from '@events/schema';

export type Platform = 'android' | 'ios' | 'unknown';

export type Env = {
  platform: Platform;
  appId?: string; // Android packageName or iOS bundleId
  appVer?: string; // Best-effort target app version
  arch?: string;
  javaAvailable?: boolean;
  objcAvailable?: boolean;
};

export type Selector = {
  platform?: Platform;
  appId?: string | RegExp;
  appVer?: string | RegExp;
  layer?: 'java' | 'objc' | 'native';
  tags?: string[];
  predicate?: (_env: Env) => boolean; // Optional fine-grained filter
};

export type ModuleMeta = {
  id: string;
  selector: Selector;
  priority?: number; // Higher priority activates first
  activate: (_ctx: Ctx) => Promise<void> | void;
  deactivate?: (_ctx: Ctx) => Promise<void> | void;
};

export type RecipeEventInput = Omit<TraceEvent, 'ts' | 'source' | 'module'> & {
  ts?: number;
  source?: TraceEvent['source'];
  module?: string;
};

export type RecipeMeta = {
  id: string;
  description: string;
  tags?: string[];
};

export type RecipeRuntime = RecipeMeta & {
  activate: (_ctx: RecipeCtx) => Promise<void> | void;
  deactivate?: (_ctx: RecipeCtx) => Promise<void> | void;
};

export type RecipeSelection = {
  ids: string[];
  flags?: Record<string, any>;
};

export type TargetConfig = {
  enable?: string[]; // Capability tags such as ["http", "crypto"]
  flags?: Record<string, any>;
  overrides?: {
    classes?: Record<string, any>;
    symbols?: Record<string, any>;
  };
  recipes?: RecipeSelection;
};

export type Ctx = {
  env: Env;
  cfg: TargetConfig;
  log: (_msg: string, ..._args: any[]) => void;
};

export type RecipeCtx = Ctx & {
  recipe: {
    id: string;
    flags: Record<string, any>;
    log: (_msg: string, ..._args: any[]) => void;
    emit: (_event: RecipeEventInput) => void;
  };
};
