import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';

import {
  createTempMergedConfig,
  loadRecipe,
  loadTargetConfig,
  mergeRecipeConfig,
  mirrorRecipeOutput,
  resolveRecipeOutputPaths,
  writeRecipeEvents,
} from './recipe-runner';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

function parseArgs() {
  const args = process.argv.slice(2);
  let dumpEvents = false;
  let dumpEventsPath = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--dump-events') {
      dumpEvents = true;
      if (args[i + 1] && !args[i + 1].startsWith('-')) {
        dumpEventsPath = args[i + 1];
      }
    }
  }

  return {
    recipe: args.find(arg => !arg.startsWith('-')),
    dumpEvents,
    dumpEventsPath,
    help: args.includes('-h') || args.includes('--help'),
  };
}

function showHelp() {
  console.log(`
Usage: node hosts/node-cli/run-recipe.js <recipe-config>

Examples:
  node hosts/node-cli/run-recipe.js configs/runs/network-observe.json
  node hosts/node-cli/run-recipe.js configs/runs/root-detect.json
  node hosts/node-cli/run-recipe.js configs/runs/network-observe.json --dump-events
`);
}

async function main() {
  const options = parseArgs();
  if (options.help || !options.recipe) {
    showHelp();
    process.exit(options.help ? 0 : 1);
  }

  const recipePath = path.isAbsolute(options.recipe)
    ? options.recipe
    : path.resolve(projectRoot, options.recipe);

  if (!fs.existsSync(recipePath)) {
    console.error(`Recipe config not found: ${recipePath}`);
    process.exit(1);
  }

  const recipe = loadRecipe(recipePath, projectRoot);
  const baseConfig = loadTargetConfig(recipe.config, projectRoot);
  const mergedConfig = mergeRecipeConfig(baseConfig, recipe);
  const { tempDir, tempPath } = createTempMergedConfig(recipePath, mergedConfig);
  const args = ['hosts/node-cli/run.js', '-c', tempPath];
  const { dumpEvents, primaryDumpPath, mirrorDumpPath } = resolveRecipeOutputPaths(
    projectRoot,
    recipePath,
    recipe,
    options.dumpEvents,
    options.dumpEventsPath
  );

  if (recipe.frontmost) {
    args.push('-F');
  } else if (recipe.target) {
    if (recipe.spawn) {
      args.push('-s');
    }
    args.push(recipe.target);
  } else {
    console.error('Recipe must specify either target or frontmost=true');
    process.exit(1);
  }

  if (recipe.verbose) {
    args.push('-v');
  }
  if (recipe.smoke) {
    args.push('--smoke');
  }
  if (recipe.timeoutMs) {
    args.push('--timeout-ms', String(recipe.timeoutMs));
  }
  if (recipe.durationMs) {
    args.push('--duration-ms', String(recipe.durationMs));
  }
  if (dumpEvents) {
    args.push('--dump-events');
    if (primaryDumpPath) {
      args.push(primaryDumpPath);
    }
  }

  console.log(`[*] Recipe: ${recipePath}`);
  if (recipe.description) {
    console.log(`[*] Description: ${recipe.description}`);
  }
  console.log(`[*] Delegating to: node ${args.join(' ')}`);

  const child = spawn('node', args, {
    cwd: projectRoot,
    stdio: 'inherit',
  });
  const startedAt = Date.now();

  child.on('close', code => {
    const exitCode = code ?? 0;
    if (dumpEvents && primaryDumpPath) {
      writeRecipeEvents(primaryDumpPath, recipe, recipePath, exitCode, startedAt, Date.now());
      console.log(`[*] Recipe events saved: ${primaryDumpPath}`);
      if (mirrorDumpPath) {
        mirrorRecipeOutput(primaryDumpPath, mirrorDumpPath);
        console.log(`[*] Recipe events mirrored: ${mirrorDumpPath}`);
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(exitCode);
  });
  child.on('error', error => {
    console.error(`Recipe runner failed: ${error.message}`);
    if (dumpEvents && primaryDumpPath) {
      writeRecipeEvents(primaryDumpPath, recipe, recipePath, 1, startedAt, Date.now());
      console.log(`[*] Recipe events saved: ${primaryDumpPath}`);
      if (mirrorDumpPath) {
        mirrorRecipeOutput(primaryDumpPath, mirrorDumpPath);
        console.log(`[*] Recipe events mirrored: ${mirrorDumpPath}`);
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    process.exit(1);
  });
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
