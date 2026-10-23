import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { readText } from '../../../lib/fsx.ts';
import { ENVIRONMENTS, type EnvName } from '../../settings/lib/game-check.ts';
import { isPlainObject, type JsonObject } from '../../settings/lib/json-path.ts';

type Condition = (env: JsonObject, adapters: JsonObject) => boolean;

const notFake = (value: unknown): boolean => value !== undefined && value !== 'fake';

/** Start text of a `build` `## deploy` bullet and when it applies to an environment. */
export const HUMAN_PREP: readonly { start: string; applies: Condition }[] = [
  { start: 'The `host` of game settings `environments.<ENV>.deploy`', applies: (env) => env.deploy !== undefined },
  { start: 'For an environment whose `adapters.turn` is `turn-coturn`', applies: (_, a) => a.turn === 'turn-coturn' },
  { start: 'For an environment whose `adapters.cdn` is `cdn-r2`', applies: (_, a) => a.cdn === 'cdn-r2' },
  { start: 'For an environment whose `adapters.ads` is `ads-admob`', applies: (_, a) => a.ads === 'ads-admob' },
  {
    start: 'For an environment whose `adapters.login-google` is `login-google`',
    applies: (_, a) => a['login-google'] === 'login-google',
  },
  {
    start: 'For an environment whose `adapters.analytics` is `analytics-ga4`',
    applies: (_, a) => a.analytics === 'analytics-ga4',
  },
  {
    start: "If an environment's `adapters.iap-apple` is `iap-apple` or",
    applies: (_, a) => a['iap-apple'] === 'iap-apple' || a['iap-apple'] === 'iap-apple-sandbox',
  },
  { start: "If an environment's `adapters.iap-google` is `iap-google`", applies: (_, a) => a['iap-google'] === 'iap-google' },
  {
    start: "If an environment's `adapters.iap-apple` or `adapters.iap-google` is not `fake`",
    applies: (_, a) => notFake(a['iap-apple']) || notFake(a['iap-google']),
  },
];

/** A top-level `## deploy` bullet: its 1-based first line and its text with continuation lines and sub-bullets. */
export interface DeployBullet {
  line: number;
  text: string;
}

/** Top-level bullets of the `## deploy` section with their lines. Shared with `ogw docs check` item `human prep`. */
export function deployBulletsAt(markdown: string): DeployBullet[] {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line === '## deploy');
  if (start === -1) throw new OgwError('build skill has no ## deploy section');
  const bullets: { line: number; lines: string[] }[] = [];
  let current: string[] | null = null;
  for (const [i, line] of lines.entries()) {
    if (i <= start) continue;
    if (line.startsWith('## ')) break;
    if (line.startsWith('- ')) {
      current = [line];
      bullets.push({ line: i + 1, lines: current });
    } else if (current && line.startsWith(' ') && line.trim() !== '') {
      current.push(line);
    } else {
      current = null;
    }
  }
  return bullets.map((bullet) => ({ line: bullet.line, text: bullet.lines.join('\n') }));
}

/** Top-level bullets of the `## deploy` section, each with its continuation lines and sub-bullets. */
export function deployBullets(markdown: string): string[] {
  return deployBulletsAt(markdown).map((bullet) => bullet.text);
}

/** Whether a `## deploy` bullet is the bullet of a human prep start text. */
export function bulletStartsWith(bullet: string, start: string): boolean {
  return bullet.startsWith(`- ${start}`);
}

/** The one bullet per start text; fails when a start text has no bullet or more than one. */
export function bulletsByStart(bullets: readonly string[]): Map<string, string> {
  const found = new Map<string, string>();
  for (const { start } of HUMAN_PREP) {
    const matches = bullets.filter((bullet) => bulletStartsWith(bullet, start));
    if (matches.length !== 1) throw new OgwError(`build skill ## deploy has ${String(matches.length)} bullets that start with: ${start}`);
    found.set(start, matches[0] as string);
  }
  return found;
}

/** Bullets that apply to each environment, in order. */
export async function humanPrep(harness: string, settings: JsonObject): Promise<Record<EnvName, string[]>> {
  const bullets = bulletsByStart(deployBullets(await readText(join(harness, 'skills', 'build', 'SKILL.md'))));
  const environments = isPlainObject(settings.environments) ? settings.environments : {};
  const out = { DEV: [], STG: [], PROD: [] } as Record<EnvName, string[]>;
  for (const name of ENVIRONMENTS) {
    const env = environments[name];
    if (!isPlainObject(env)) continue;
    const adapters = isPlainObject(env.adapters) ? env.adapters : {};
    for (const { start, applies } of HUMAN_PREP) if (applies(env, adapters)) out[name].push(bullets.get(start) as string);
  }
  return out;
}

export function humanPrepText(prep: Record<EnvName, string[]>): string {
  return ENVIRONMENTS.map((name) => [`## ${name}`, ...prep[name]].join('\n')).join('\n\n');
}
