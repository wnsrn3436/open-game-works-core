// Harness consistency check items: schema, native agents, human prep.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from '../../../lib/fsx.ts';
import { loadSchema, validateAgainst } from '../../../lib/settings.ts';
import { bulletStartsWith, deployBulletsAt, HUMAN_PREP, type DeployBullet } from '../../game/lib/human-prep.ts';
import { at, type DocFile, type Failure } from './files.ts';

/** Bullet start texts that `ogw game check --human-prep` looks for in `skills/build/SKILL.md` `## deploy`. */
export const HUMAN_PREP_BULLET_STARTS: readonly string[] = HUMAN_PREP.map((h) => h.start);

export async function checkSchema(harness: string): Promise<Failure[]> {
  const item = 'schema';
  const settingsPath = join(harness, 'settings.json');
  const schemaPath = join(harness, 'schemas', 'harness-settings.schema.json');
  try {
    const errors = validateAgainst(await loadSchema(schemaPath), await readJson(settingsPath));
    return errors.map((reason) => ({ item, where: 'settings.json', reason }));
  } catch (error) {
    return [{ item, where: 'settings.json', reason: error instanceof Error ? error.message : String(error) }];
  }
}

export function checkNativeAgents(harness: string): Failure[] {
  return ['.claude/agents', '.codex/agents']
    .filter((dir) => existsSync(join(harness, dir)))
    .map((dir) => ({ item: 'native agents', where: dir, reason: 'native agent definitions must not exist' }));
}

export function checkHumanPrep(build: DocFile | undefined, starts: readonly string[] = HUMAN_PREP_BULLET_STARTS): Failure[] {
  const item = 'human prep';
  const where = build?.rel ?? 'skills/build/SKILL.md';
  if (!build) return [{ item, where, reason: 'no ## deploy section' }];
  let bullets: DeployBullet[];
  try {
    bullets = deployBulletsAt(build.lines.map((l) => l.text).join('\n'));
  } catch {
    return [{ item, where, reason: 'no ## deploy section' }];
  }
  const failures: Failure[] = [];
  for (const start of starts) {
    const found = bullets.filter((b) => bulletStartsWith(b.text, start));
    if (found.length === 1) continue;
    const lines = found.map((b) => String(b.line)).join(', ');
    failures.push({ item, where: lines === '' ? where : at(where, found[0]?.line), reason: `${String(found.length)} bullets in ## deploy start with "${start}"${lines === '' ? '' : ` (lines ${lines})`}; there must be one` });
  }
  return failures;
}
