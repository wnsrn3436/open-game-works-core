import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeFileAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { startInstance, stopInstance } from '../instance/api.ts';
import { cell, column, parseTable, section } from '../loop/lib/markdown.ts';
import { commitOnMain, prepareMain } from './lib/guard.ts';
import { hasCommit, judgedPairs, labeled, LABELS_FILE, readLabels, type Answer, type JudgedPair, type LabelEntry } from './lib/pairs.ts';

const USAGE = 'ogw judge label <game>';

/** What tests replace: the coin of the A and B mapping, the clock and the questions to the human. */
export const labelDeps = {
  /** Returns a number in [0, 1); below 0.5 maps the instance commit to `A`. */
  random: Math.random,
  now: Date.now,
  /** Prints the question in the terminal and returns the line the human typed. */
  ask: async (question: string): Promise<string> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
};

/** An element of `## fun judgement criteria` of `agents/judge.md` and its `looks at` text. */
export interface Criterion {
  element: string;
  looksAt: string;
}

/** The elements of `## fun judgement criteria` of the harness `agents/judge.md`, in table order. */
export async function funCriteria(ctx: Context): Promise<Criterion[]> {
  const text = await readFile(join((await ctx.workspace()).harness, 'agents', 'judge.md'), 'utf8');
  const table = parseTable(section(text, 'fun judgement criteria') ?? []);
  if (table === null) throw new OgwError('agents/judge.md `## fun judgement criteria` has no table');
  const element = column(table, 'element');
  const looksAt = column(table, 'looks at');
  return table.rows.map((row) => ({ element: cell(row, element), looksAt: cell(row, looksAt) }));
}

/** The most recent judged pair whose commits are in the game repo and that no entry has; null when there is none. */
async function pairToLabel(ctx: Context, game: GameRepo, labels: readonly LabelEntry[]): Promise<JudgedPair | null> {
  for (const pair of await judgedPairs(game.root, ctx.env)) {
    if (labeled(labels, pair)) continue;
    if ((await hasCommit(game.root, pair.commit, ctx.env)) && (await hasCommit(game.root, pair.baseline, ctx.env))) return pair;
  }
  return null;
}

/** Starts the instance of one side as a judge instance, lets the human play it until Enter, then stops it. */
async function playSide(ctx: Context, game: GameRepo, side: 'A' | 'B', commit: string): Promise<void> {
  const instance = await startInstance(ctx, { game: game.name, commit, client: 'window', played: true });
  try {
    await labelDeps.ask(`Play ${side} in the game window that opened. Press Enter when you are done with ${side}. `);
  } finally {
    await stopInstance(ctx, instance.id);
  }
}

const ANSWERS: Readonly<Record<string, Answer>> = { a: 'A', b: 'B', s: 'same' };

/** Asks `a`, `b` or `s` for each element until the human types one of them. */
async function askAnswers(criteria: readonly Criterion[]): Promise<Record<string, Answer>> {
  const answers: Record<string, Answer> = {};
  for (const { element, looksAt } of criteria) {
    for (;;) {
      const typed = (await labelDeps.ask(`${element}: ${looksAt}\nWhich is better? a (A), b (B) or s (same): `)).trim().toLowerCase();
      const answer = ANSWERS[typed];
      if (answer !== undefined) {
        answers[element] = answer;
        break;
      }
    }
  }
  return answers;
}

/**
 * `ogw judge label <game>` (`game-loop` `## judge calibration`): the human plays the two commits of a judged pair as
 * `A` and `B` and answers per element; the answers go into `records/calibration/labels.json` on main.
 */
export const judgeLabel: CommandDef = {
  name: ['judge', 'label'],
  usage: USAGE,
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    if (!ctx.terminal()) throw new OgwError('ogw judge label asks the human: run it in a terminal');
    const game = await ctx.game(positional(args, 0, 'game'));
    await prepareMain(ctx, game);
    const labels = await readLabels(game.root);
    const pair = await pairToLabel(ctx, game, labels);
    if (pair === null) return { text: 'no judged pair without a label', data: { labeled: null } };
    const thisIsA = labelDeps.random() < 0.5;
    const A = thisIsA ? pair.commit : pair.baseline;
    const B = thisIsA ? pair.baseline : pair.commit;
    await playSide(ctx, game, 'A', A);
    await playSide(ctx, game, 'B', B);
    const answers = await askAnswers(await funCriteria(ctx));
    const note = (await labelDeps.ask('Note (one line, Enter for none): ')).trim();
    const entry: LabelEntry = { A, B, answers, note, at: labelDeps.now() };
    await writeFileAtomic(join(game.root, LABELS_FILE), `${JSON.stringify([...labels, entry], null, 2)}\n`);
    await commitOnMain(ctx, game, [LABELS_FILE], `judge label: ${A.slice(0, 7)} ${B.slice(0, 7)}`);
    return { text: `labeled A ${A} and B ${B} in ${LABELS_FILE} (${String(labels.length + 1)} labels)`, data: { labeled: entry, labels: labels.length + 1 } };
  },
};
