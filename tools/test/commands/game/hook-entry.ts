// A pre-commit hook entry for tests: the real hook process (`hookMain`, `ogw meta sync`) with a static check that
// only builds the temporary worktree of the staged changes (the generated diff and contract worktree) and compares
// `note.txt` there with the committing checkout. A `blocked.txt` in the temporary worktree that holds `block` gives a
// failure. Usage: node hook-entry.ts <game>
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CheckFailure } from '../../../src/commands/check/api.ts';
import { withStagedWorktree } from '../../../src/commands/check/static/generated-diff.ts';
import { StaticContext } from '../../../src/commands/check/static/lib/context.ts';
import { hookMain } from '../../../src/commands/game/lib/pre-commit.ts';
import { commands } from '../../../src/commands/index.ts';
import { runCli } from '../../../src/lib/cli.ts';

function read(path: string): string | null {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

process.exitCode = await hookMain(process.argv[2] ?? '', {
  ogw: (argv, io) => runCli(commands, argv, io),
  staticCheck: async (ctx, game, options) => {
    const sc = await StaticContext.create(ctx, game, options.stagedEnv);
    const failures = await withStagedWorktree(sc, (temp) => {
      const out: CheckFailure[] = [];
      if (read(join(temp.root, 'note.txt')) !== read(join(game.root, 'note.txt'))) {
        out.push({ where: 'note.txt', message: 'staged note.txt differs in the temporary worktree', evidence: [] });
      }
      if (read(join(temp.root, 'blocked.txt'))?.includes('block') === true) out.push({ where: 'blocked.txt:1', message: 'blocked', evidence: [] });
      return Promise.resolve(out);
    });
    return { result: { name: 'static check', platform: null, result: failures.length > 0 ? 'fail' : 'pass', failures, warnings: [] }, absent: [] };
  },
});
