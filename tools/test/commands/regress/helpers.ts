import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createContext, type Context } from '../../../src/lib/command.ts';
import type { CheckResult } from '../../../src/commands/check/api.ts';
import type { RegressCheckFile } from '../../../src/commands/regress/lib/keys.ts';
import { commitAll, makeGame, sh, type TestWorkspace } from '../../helpers/workspace.ts';

export function ctxOf(ws: TestWorkspace, env: NodeJS.ProcessEnv = {}): Context {
  return createContext({ cwd: ws.root, env: { ...ws.env, ...env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

export function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

export const TABLE = ['comment,,', 'All,All,All', 'id(key),int,int', 'id,hero_health,sim_turns_min', '[opp_a],14,5', '[opp_b],18,10', ''].join('\n');

/**
 * A source game `games/<name>/`: its records with a loop run, a setup file, two client tests, a table, a translation,
 * and an `id-registry` branch. Returns its main commit.
 */
export function sourceGame(ws: TestWorkspace, name = 'src'): string {
  const root = makeGame(ws, name, {
    'settings.json': { coreVersion: '1.0.0' },
    '.gitignore': '/builds/\nrecords/loops/*/evidence/\n',
    'brief.md': '# brief\n',
    'records/setup/request.md': 'make a game\n',
    'records/loops/update-1/iteration-1.md': '## defects\n\nthe answer\n',
    'client/tests/test_a.gd': 'extends UnitTestCase\n\nfunc test_one() -> void:\n\tpass\n\nfunc test_two() -> void:\n\tpass\n',
    'client/a.gd': 'var x = 1\n',
    'data/tables/opponent.csv': TABLE,
    'data/translations/en.csv': 'key,source,source_hash,current_hash,text\na,가,h1,h1,A\nb,나,h2,h3,B\nc,다,h4,h4,\n',
  });
  sh(root, 'git', ['checkout', '--quiet', '--orphan', 'id-registry']);
  sh(root, 'git', ['rm', '-rf', '--quiet', '.']);
  write(root, 'id_registry.json', '{"opp_a": 1}\n');
  commitAll(root, 'registry');
  sh(root, 'git', ['checkout', '--quiet', 'main']);
  return sh(root, 'git', ['rev-parse', 'main']).trim();
}

export function item(name: string, result: CheckResult['result'], failures: [string, string][] = [], platform: string | null = null): CheckResult {
  return { name, platform, result, failures: failures.map(([where, message]) => ({ where, message, evidence: [] })), warnings: [] };
}

export function checkFile(commit: string, ...checks: CheckResult[]): RegressCheckFile {
  return { commit, checks, fixTestProof: [] };
}

/** The time a piece of work of `group` ran, from its start to its end. */
export interface Span {
  key: string;
  group: string;
  start: number;
  end: number;
}

function overlap(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** The spans of each key joined into one, from the first start to the last end. */
export function joinedSpans(spans: readonly Span[]): Span[] {
  const byKey = new Map<string, Span>();
  for (const s of spans) {
    const seen = byKey.get(s.key);
    byKey.set(s.key, seen === undefined ? { ...s } : { ...seen, start: Math.min(seen.start, s.start), end: Math.max(seen.end, s.end) });
  }
  return [...byKey.values()];
}

/** The pairs of spans that ran at the same time, as `<key> <key>`: only pairs of the same group with `sameGroup`, else only pairs of different groups. */
export function overlaps(spans: readonly Span[], sameGroup: boolean): string[] {
  const pairs: string[] = [];
  spans.forEach((a, i) => {
    for (const b of spans.slice(i + 1)) if ((a.group === b.group) === sameGroup && overlap(a, b)) pairs.push(`${a.key} ${b.key}`);
  });
  return pairs;
}

/** The keys of the other spans that ran while `span` ran. */
export function runningBeside(spans: readonly Span[], span: Span): string[] {
  return spans.filter((s) => s !== span && overlap(s, span)).map((s) => s.key);
}

/**
 * Starts a piece of work of `group` and waits until a piece of work of another group has started too, or `limitMs`
 * has passed: work of two groups that runs together gets past it at once, and work of groups that runs one after
 * another gets past it only at the limit, with no other group started.
 */
export async function meetOtherGroup(started: Set<string>, group: string, limitMs = 10_000): Promise<void> {
  started.add(group);
  const until = Date.now() + limitMs;
  while (![...started].some((g) => g !== group) && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 5));
}
