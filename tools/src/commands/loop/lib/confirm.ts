import type { GameRepo } from '../../../lib/game.ts';
import type { RunState } from '../../../lib/runstate.ts';
import { afterReport, iterationLabel, recordBase, type DefectAnswers, type DefectsFile, type ReportRow } from './defects.ts';
import type { CheckFile, EvaluateFile } from './files.ts';
import { playAnswers } from './results.ts';
import { readGameText, readRunJson } from './run.ts';

/** The confirmation of play and judge defects by the play agents (ogw.md `## loop evaluate`, `## loop record`). */

/** A defect to confirm as a play input gives it (`agents/play.md`). */
export interface PlayDefect {
  id: string;
  where: string;
  what: string;
  /** The text of each play feedback line its `evidence` points to. */
  seen: string[];
}

/** A play feedback line that an `evidence` entry points to: `<.../play-<n>-<k>.md>:<line>`. */
const FEEDBACK_LINE = /^(.*(?:^|\/)play-\d+-\d+\.md):(\d+)$/;

/** The text of each play feedback line that `evidence` points to, in `evidence` order; a line that is not there is left out. */
async function seenLines(game: GameRepo, evidence: readonly string[]): Promise<string[]> {
  const lines: string[] = [];
  for (const entry of evidence) {
    const match = FEEDBACK_LINE.exec(entry);
    if (!match) continue;
    const text = await readGameText(game, match[1] as string);
    const line = text?.split(/\r?\n/)[Number(match[2]) - 1]?.trim();
    if (line !== undefined && line !== '') lines.push(line);
  }
  return lines;
}

/**
 * The defects to confirm of the iteration (ogw.md `## loop evaluate`): those of the defect list that the record of the
 * iteration starts from (`recordBase`: before an earlier record of the same iteration) of source `play` or `judge` that
 * are `awaiting confirmation` after the status changes by `report`, the `## defects` rows of the content agent report of
 * the iteration, with the fix test proof of `check`, in defect list order.
 */
export async function defectsToConfirm(game: GameRepo, run: RunState, check: CheckFile, report: ReadonlyMap<string, ReportRow>): Promise<PlayDefect[]> {
  const file = recordBase(await readRunJson<DefectsFile>(game, run, 'defects.json'), iterationLabel(run.iteration));
  const proofs = new Map((check.fixTestProof ?? []).map((p) => [p.id, p.result]));
  const out: PlayDefect[] = [];
  for (const defect of file?.defects ?? []) {
    if (defect.source !== 'play' && defect.source !== 'judge') continue;
    if (afterReport(defect, report.get(defect.id), proofs.get(defect.id)).status !== 'awaiting confirmation') continue;
    out.push({ id: defect.id, where: defect.where, what: defect.what, seen: await seenLines(game, defect.evidence) });
  }
  return out;
}

/**
 * The answers of the plays of `evaluate` whose `status` is `done` (ogw.md `## loop record`): per defect id, whether one
 * answered `reproduced` or `absent`, and the feedback line and capture of each `reproduced` row.
 */
export async function playAnswersOf(game: GameRepo, evaluate: EvaluateFile | null): Promise<Map<string, DefectAnswers>> {
  const out = new Map<string, DefectAnswers>();
  for (const play of evaluate?.plays.filter((p) => p.status === 'done') ?? []) {
    const text = await readGameText(game, play.result);
    for (const row of text === null ? [] : playAnswers(text).rows) {
      const answers = out.get(row.id) ?? { reproduced: false, absent: false, evidence: [] };
      if (row.result === 'reproduced') {
        answers.reproduced = true;
        answers.evidence.push(`${play.result}:${String(row.line)}`, ...(row.capture === '' || row.capture === 'none' ? [] : [row.capture]));
      }
      if (row.result === 'absent') answers.absent = true;
      out.set(row.id, answers);
    }
  }
  return out;
}
