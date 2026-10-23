import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isRecord, JsonPosError, parseJsonWithLines } from './lib/json-pos.ts';

/**
 * haptic format: a `resource/haptic/` file is not a `SoundCore` haptic pattern: a UTF-8 JSON object
 * `{"segments": [{"delay_ms": <int>, "duration_ms": <int>, "intensity": <int>}, ...]}` with at least one segment,
 * `delay_ms` 0 or more, `duration_ms` 1 or more, `intensity` 0 to 1000, and no other key.
 */
export const NAME = 'haptic format';

const SEGMENT_KEYS = ['delay_ms', 'duration_ms', 'intensity'];
const RANGES: Record<string, [number, number]> = { delay_ms: [0, Infinity], duration_ms: [1, Infinity], intensity: [0, 1000] };

function segmentProblem(seg: unknown): string | null {
  if (!isRecord(seg)) return 'segment is not an object';
  const extra = Object.keys(seg).filter((k) => !SEGMENT_KEYS.includes(k));
  if (extra.length > 0) return `unknown key \`${extra.join('`, `')}\``;
  for (const key of SEGMENT_KEYS) {
    const value = seg[key];
    const [min, max] = RANGES[key] as [number, number];
    if (typeof value !== 'number' || !Number.isInteger(value)) return `\`${key}\` is not an integer`;
    if (value < min || value > max) return `\`${key}\` ${String(value)} is out of range`;
  }
  return null;
}

/** Problems of one haptic file: `[line, message]`. */
export function problems(text: string): [number, string][] {
  let parsed;
  try {
    parsed = parseJsonWithLines(text);
  } catch (error) {
    return [[error instanceof JsonPosError ? error.line : 1, 'not JSON']];
  }
  const { value, lines } = parsed;
  if (!isRecord(value)) return [[1, 'not a JSON object']];
  const extra = Object.keys(value).filter((k) => k !== 'segments');
  const out: [number, string][] = extra.map((k) => [lines.get(`/${k}`) ?? 1, `unknown key \`${k}\``]);
  const segments = value.segments;
  if (!Array.isArray(segments) || segments.length === 0) {
    out.push([lines.get('/segments') ?? 1, '`segments` is not a list of one or more segments']);
    return out;
  }
  segments.forEach((seg, i) => {
    const problem = segmentProblem(seg);
    if (problem) out.push([lines.get(`/segments/${String(i)}`) ?? 1, `segment ${String(i)}: ${problem}`]);
  });
  return out;
}

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const files = sc.filter((p) => p.startsWith('resource/haptic/') && !/\.(import|uid)$/.test(p));
  const results = await Promise.all(
    files.map(async (path) => {
      const text = decodeUtf8(await sc.bytes(path));
      if (text === null) return [finding(NAME, at(path, 1), 'not UTF-8')];
      return problems(text).map(([line, message]) => finding(NAME, at(path, line), message));
    }),
  );
  return results.flat();
}
