// An open loop run of a game whose pin holds run settings (ogw.md `## loop start`), for the generation commands that read them.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HARNESS_PINS_KEY } from '../../../src/commands/loop/lib/harness-pin.ts';
import { currentRunSettings } from '../../../src/lib/settings.ts';
import type { JsonObject } from '../../../src/lib/json.ts';
import { sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { openLoopRun, setRun, type TestGame } from '../loop/helpers.ts';

/**
 * Opens a loop run of the game `games/<name>/` whose pin holds the run settings of harness settings now, as `ogw loop
 * start` pins them, or `runSettings` when given.
 */
export async function openPinnedRun(ws: TestWorkspace, name: string, runSettings?: JsonObject): Promise<TestGame> {
  const root = join(ws.games, name);
  const g: TestGame = { ws, root, repo: { name, root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false } };
  const commit = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
  await openLoopRun(g, { data: { [HARNESS_PINS_KEY]: [{ commit, iteration: 0, runSettings: runSettings ?? (await currentRunSettings(ws.env)) }] } });
  return g;
}

/** Closes the run of `openPinnedRun`. */
export function closeRun(g: TestGame): Promise<void> {
  return setRun(g, (run) => {
    run.closedAt = Date.now();
  });
}

/** Writes the local harness settings of the workspace: values of this host that differ from those the run pinned. */
export function writeLocalSettings(ws: TestWorkspace, value: Record<string, unknown>): void {
  writeFileSync(join(ws.harness, 'settings.local.json'), JSON.stringify(value));
}
