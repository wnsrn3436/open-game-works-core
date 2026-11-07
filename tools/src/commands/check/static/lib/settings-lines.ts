import { matchCoreKey } from '../../../settings/lib/core-files.ts';
import { isRecord, JsonPosError, parseJsonWithLines, valueLine, type JsonWithLines } from './json-pos.ts';

/**
 * The JSON segments of a game settings path. A `core.<key>` path splits after the longest core settings key that `core`
 * holds as one key (`NetworkCore.retryCount`), and at each `.` otherwise.
 */
export function settingsSegments(settings: unknown, path: string): string[] {
  if (!path.startsWith('core.')) return path.split('.');
  const text = path.slice('core.'.length);
  const core = isRecord(settings) ? settings.core : undefined;
  const key = isRecord(core) ? matchCoreKey(Object.keys(core), text) : null;
  if (key === null) return ['core', ...text.split('.')];
  return ['core', key, ...(text === key ? [] : text.slice(key.length + 1).split('.'))];
}

/**
 * The `where` line in `settings.json` text of a failure about the game settings value at `path` (ogw.md `## static
 * check`): the line where that value starts, or, when it is absent, where the nearest value that holds its place starts;
 * 1 when the text does not parse.
 */
export function settingsLine(text: string, path: string): number {
  let parsed: JsonWithLines;
  try {
    parsed = parseJsonWithLines(text);
  } catch (error) {
    if (error instanceof JsonPosError) return 1;
    throw error;
  }
  return valueLine(parsed, settingsSegments(parsed.value, path));
}
