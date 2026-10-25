import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { git, worktreeAdd, worktreeRemove } from '../../lib/git.ts';
import { LIMITS } from '../../lib/limits.ts';
import { coreTryChecks } from '../check/api.ts';
import { dataDir } from '../env/lib/host.ts';
import { generateCheckout } from '../generate/api.ts';

/**
 * A context in `cwd` whose harness settings have `useLocalCore` true: the core of the checkout is built from
 * `open-game-works-core-impl/` in place of the core version of the game.
 */
function localCoreContext(ctx: Context, cwd: string): Context {
  const inner = createContext({
    cwd,
    env: ctx.env,
    stdin: () => ctx.stdin(),
    stderr: (text) => {
      ctx.log(text.trimEnd());
    },
  });
  return { ...inner, settings: async () => ({ ...(await ctx.settings()), useLocalCore: true }) };
}

/** `ogw core try <game>` (`core` command.md `update core` 4). Changes nothing in the game repo. */
export const tryCommand: CommandDef = {
  name: ['core', 'try'],
  usage: 'ogw core try <game>',
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => LIMITS.jobMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const id = `try-${String(Date.now())}`;
    const worktree = join((await ctx.workspace()).worktrees, game.name, id);
    const evidenceRoot = join(await dataDir(ctx), 'core-try', game.name, id);
    await mkdir(evidenceRoot, { recursive: true });
    const main = (await git(game.mainRoot, ['rev-parse', 'main'], { env: ctx.env })).trim();
    await worktreeAdd(game.mainRoot, worktree, main, undefined, { env: ctx.env });
    try {
      const local = localCoreContext(ctx, worktree);
      const checkout = await local.game(game.name);
      await generateCheckout(local, checkout);
      // `generated diff` reads HEAD plus the staged changes: staged in the worktree's own index, they are the local-core output
      await git(worktree, ['add', '-A'], { env: ctx.env });
      const { checks, lines } = await coreTryChecks(local, checkout, { root: evidenceRoot, dir: '.', relative: false });
      const failed = checks.some((c) => c.result === 'fail');
      const text = [`core try ${game.name} at main ${main.slice(0, 12)} with the local core`, ...lines, `evidence: ${evidenceRoot}`].join('\n');
      return { exitCode: failed ? 1 : 0, text, data: { game: game.name, commit: main, checks, evidence: evidenceRoot } };
    } finally {
      await worktreeRemove(game.mainRoot, worktree, { env: ctx.env });
    }
  },
};
