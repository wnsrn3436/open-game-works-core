import type { GameRepo } from '../../lib/game.ts';
import { gitRaw, showFile } from '../../lib/git.ts';
import { CALIBRATION_DIR, LABELS_FILE, parseLabels } from './lib/pairs.ts';
import { parseReport } from './lib/report.ts';

export { refuseWhileCalibrating } from './lib/guard.ts';

const REPORT = new RegExp(`^${CALIBRATION_DIR}/(\\d+)\\.md$`);

/** The number of entries of `labels.json` on main, or `unreadable` when it is not an array of entries. */
async function labelCount(game: GameRepo, env: NodeJS.ProcessEnv): Promise<string> {
  const text = await showFile(game.root, 'main', LABELS_FILE, { env });
  if (text === null) return '0';
  try {
    return String(parseLabels(text.toString('utf8')).length);
  } catch {
    return 'unreadable';
  }
}

/** The path of the judge calibration report on main with the highest unix ms; null without one. */
async function lastReport(game: GameRepo, env: NodeJS.ProcessEnv): Promise<string | null> {
  const listed = await gitRaw(game.root, ['ls-tree', '--name-only', 'main', '--', `${CALIBRATION_DIR}/`], { env });
  if (listed.code !== 0) return null;
  const reports = listed.stdout
    .split('\n')
    .map((path) => ({ path, ms: REPORT.exec(path)?.[1] }))
    .filter((r): r is { path: string; ms: string } => r.ms !== undefined)
    .sort((a, b) => Number(b.ms) - Number(a.ms));
  return reports[0]?.path ?? null;
}

/** The judge calibration lines of loop end record `## human` (`game-loop` `### end-record`). */
export async function calibrationHumanLines(game: GameRepo, env: NodeJS.ProcessEnv): Promise<string[]> {
  const path = await lastReport(game, env);
  const text = path === null ? null : await showFile(game.root, 'main', path, { env });
  if (path === null || text === null) {
    return [`judge calibration: never run (ogw judge calibrate ${game.name}; labels: ${await labelCount(game, env)}, added with ogw judge label ${game.name})`];
  }
  const report = parseReport(text.toString('utf8'));
  return [`judge calibration: ${path}: ${report.rates.join('; ')}`, ...report.recommendations.map((line) => `judge calibration recommendation: ${line}`)];
}
