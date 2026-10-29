import { normalizeExternalLine } from '@events/parsers/external';
import { TraceEvent } from '@events/schema';

export function normalizeCommunitySnippetText(text: string): TraceEvent[] {
  return text
    .split(/\r?\n/)
    .flatMap(line => normalizeExternalLine(line, 'community'));
}
