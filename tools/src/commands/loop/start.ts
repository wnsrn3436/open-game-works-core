import { mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectPositionals, positional, str, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { branchExists, commitPaths, currentBranch, git, gitRaw, head, revParse, statusLines } from '../../lib/git.ts';
import { harnessRoot } from '../../lib/paths.ts';
import { changeRuns, newRunState, openRun } from '../../lib/runstate.ts';
import { missingLoginToken } from '../secret/lib/login-token.ts';
import { gameCheckErrors } from '../settings/api.ts';
import { column, parseTable, section, sectionText, unquote } from './lib/markdown.ts';
import { gameSettings } from './lib/run.ts';
import { ART_DIRECTION_FILE, NAME_FILE, REFERENCE_FILE, SETUP_REQUEST, artDirectionGaps, readGameNames, requireReference } from './lib/setup.ts';

const USAGE = 'ogw loop start <game> --command <create|update>';

/** Headings of the `game-design` `## brief` table, in order. */
export async function briefHeadings(env: NodeJS.ProcessEnv): Promise<string[]> {
  const text = await readFile(join(harnessRoot(env), 'skills', 'game-design', 'SKILL.md'), 'utf8');
  const table = parseTable(section(text, 'brief') ?? []);
  if (!table) throw new OgwError('skills/game-design/SKILL.md `## brief` has no heading table');
  const col = column(table, 'heading');
  return table.rows.map((row) => unquote(row.cells[col] ?? '').replace(/^##\s+/, ''));
}

/** Why `setup game` is not done; empty when it is done. */
async function setupMissing(ctx: Context, game: GameRepo): Promise<string[]> {
  const missing: string[] = [];
  const errors = await gameCheckErrors(ctx, game);
  if (errors.length > 0) missing.push(`game settings do not pass ogw game check: ${errors.join('; ')}`);
  if (!(await branchExists(game.root, 'id-registry', { env: ctx.env }))) missing.push('branch id-registry');
  if (!exists(join(game.root, SETUP_REQUEST))) missing.push(SETUP_REQUEST);
  if (!exists(join(game.root, REFERENCE_FILE))) missing.push(REFERENCE_FILE);
  const names = await readGameNames(game);
  const languages = (await gameSettings(ctx, game)).supportedLanguages ?? [];
  const unnamed = languages.filter((language) => !names?.has(language));
  if (names === null) missing.push(NAME_FILE);
  else if (unnamed.length > 0) missing.push(`game name of ${unnamed.join(', ')} in ${NAME_FILE}`);
  const gaps = await artDirectionGaps(game);
  if (gaps === null) missing.push(ART_DIRECTION_FILE);
  else if (gaps.length > 0) missing.push(`${gaps.join(', ')} in ${ART_DIRECTION_FILE}`);
  return missing;
}

function requestText(command: 'create' | 'update', setup: string, stdin: string): string {
  if (command === 'update') return stdin;
  return `${setup.endsWith('\n') ? setup : `${setup}\n`}\n${stdin}`;
}

async function briefDraft(ctx: Context, game: GameRepo, request: string): Promise<string> {
  const reference = await readFile(join(game.root, REFERENCE_FILE), 'utf8');
  const fill: Record<string, string> = {
    'reference game': `${sectionText(reference, 'game') ?? ''}\n\n${REFERENCE_FILE}`,
    request: request.trim(),
  };
  return (await briefHeadings(ctx.env)).map((h) => `## ${h}\n\n${fill[h] ? `${fill[h]}\n\n` : ''}`).join('').replace(/\n+$/, '\n');
}

async function writeFiles(ctx: Context, game: GameRepo, run: string, command: 'create' | 'update', stdin: string): Promise<string[]> {
  const setup = command === 'create' ? await readFile(join(game.root, SETUP_REQUEST), 'utf8') : '';
  const request = requestText(command, setup, stdin);
  const requestRel = `records/loops/${run}/request.md`;
  await mkdir(dirname(join(game.root, requestRel)), { recursive: true });
  await writeFileAtomic(join(game.root, requestRel), request);
  const paths = [requestRel];
  if (command === 'create' && !exists(join(game.root, 'brief.md'))) {
    await writeFileAtomic(join(game.root, 'brief.md'), await briefDraft(ctx, game, request));
    paths.push('brief.md');
  }
  return paths;
}

async function dropRun(game: GameRepo, name: string): Promise<void> {
  await changeRuns(game, (runs) => {
    runs.splice(0, runs.length, ...runs.filter((r) => r.name !== name));
  });
}

/** Puts the checkout back on `origin` (the branch or commit it was on before the start) and deletes the work branch. */
async function rollBack(game: GameRepo, branch: string, origin: string): Promise<void> {
  await gitRaw(game.root, ['reset', '--hard', '--quiet']);
  await gitRaw(game.root, ['clean', '-fd', '--quiet', '--', 'records']);
  await gitRaw(game.root, ['checkout', '--quiet', origin]);
  await gitRaw(game.root, ['branch', '-D', branch]);
}

export const loopStart: CommandDef = {
  name: ['loop', 'start'],
  usage: USAGE,
  options: { command: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const command = str(args, 'command');
    if (command !== 'create' && command !== 'update') throw new OgwError(`usage: ${USAGE}`);
    const game = await ctx.game(positional(args, 0, 'game'));
    // The open run is checked first: an interrupted iteration leaves changes in the checkout, and the lead agent needs the run name.
    const open = await openRun(game);
    if (open) throw new OgwError(`game ${game.name} has an open run: ${open.name}`, 1, { run: open.name });
    const changes = await statusLines(game.root, { env: ctx.env });
    if (changes.length > 0) throw new OgwError(`game repo checkout has changes:\n${changes.join('\n')}`, 1, { changes });
    const tokenMissing = missingLoginToken(ctx, await ctx.settings());
    if (tokenMissing !== null) throw new OgwError(tokenMissing);
    const origin = (await currentBranch(game.root, { env: ctx.env })) ?? (await head(game.root, { env: ctx.env }));
    const stdin = await ctx.stdin();
    const name = `${command}-${String(Date.now())}`;
    const branch = `loop/${name}`;
    // The run is registered under the run file lock before any git change, so a concurrent start fails before it touches git.
    // main is read under the same lock, which commands that commit to main hold, so the base commit is main HEAD at registration.
    const baseCommit = await changeRuns(game, async (runs) => {
      const other = runs.find((r) => r.closedAt === null);
      if (other) throw new OgwError(`game ${game.name} has an open run: ${other.name}`, 1, { run: other.name });
      const main = await revParse(game.root, 'main', { env: ctx.env });
      if (main === null) throw new OgwError('game repo has no main branch');
      runs.push(newRunState({ name, kind: 'loop', command, branch, baseCommit: main }));
      return main;
    });
    try {
      await git(game.root, ['checkout', '--quiet', '-b', branch, baseCommit], { env: ctx.env });
    } catch (error) {
      await dropRun(game, name);
      throw error;
    }
    try {
      // The setup state and the reference are the ones of main, which the work branch now holds.
      if (command === 'create') {
        const missing = await setupMissing(ctx, game);
        if (missing.length > 0) throw new OgwError(`setup game is not done: ${missing.join('; ')}`, 1, { missing });
      }
      await requireReference(game);
      const paths = await writeFiles(ctx, game, name, command, stdin);
      await commitPaths(game.root, paths, `loop ${name}: start`, { env: ctx.env });
    } catch (error) {
      await rollBack(game, branch, origin);
      await dropRun(game, name);
      throw error;
    }
    return { text: `run: ${name}\nbase commit: ${baseCommit}`, data: { run: name, branch, baseCommit } };
  },
};
