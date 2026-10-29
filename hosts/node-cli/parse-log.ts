import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeExternalLine, type ExternalParserHint } from '@events/parsers/external';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');

function parseArgs() {
  const args = process.argv.slice(2);
  let parser: ExternalParserHint = 'auto';
  let output = '';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--parser' && args[i + 1]) {
      parser = args[++i] as ExternalParserHint;
    } else if (args[i] === '--output' && args[i + 1]) {
      output = args[++i];
    }
  }

  const positional = args.filter((arg, index) => {
    if (arg === '--parser' || arg === '--output') {
      return false;
    }
    if (index > 0 && (args[index - 1] === '--parser' || args[index - 1] === '--output')) {
      return false;
    }
    return !arg.startsWith('--');
  });

  return {
    input: positional[0] || '',
    parser,
    output,
    help: args.includes('-h') || args.includes('--help'),
  };
}

function showHelp() {
  console.log(`
Usage: node hosts/node-cli/parse-log.js <input-log> [--parser auto|frida-trace|community] [--output FILE]

Examples:
  node hosts/node-cli/parse-log.js samples/frida-trace.log
  node hosts/node-cli/parse-log.js samples/community.log --parser community
`);
}

function makeDefaultOutputPath(inputPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const baseName = path.basename(inputPath, path.extname(inputPath)).replace(/[^\w.-]+/g, '_');
  return path.join(projectRoot, '.runtime', 'normalized', `import_${baseName}_${timestamp}.jsonl`);
}

async function main() {
  const options = parseArgs();
  if (options.help || !options.input) {
    showHelp();
    process.exit(options.help ? 0 : 1);
  }

  const inputPath = path.isAbsolute(options.input)
    ? options.input
    : path.resolve(projectRoot, options.input);
  if (!fs.existsSync(inputPath)) {
    console.error(`Input log not found: ${inputPath}`);
    process.exit(1);
  }

  const outputPath = options.output
    ? path.isAbsolute(options.output)
      ? options.output
      : path.resolve(projectRoot, options.output)
    : makeDefaultOutputPath(inputPath);

  const lines = fs.readFileSync(inputPath, 'utf8').split(/\r?\n/);
  const events = lines.flatMap(line => normalizeExternalLine(line, options.parser));

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, events.map(event => JSON.stringify(event)).join('\n') + '\n', 'utf8');

  console.log(`[*] Parsed ${events.length} events from ${inputPath}`);
  console.log(`[*] Output: ${outputPath}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
