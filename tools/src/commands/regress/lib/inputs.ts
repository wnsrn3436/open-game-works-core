/**
 * The check inputs of a harness commit (ogw.md `### regress refresh` 3): what the result of a check of its tool depends
 * on in the harness repo, so that a kept base check stays evidence for another commit with the same inputs.
 */
import { createHash } from 'node:crypto';
import type { Context } from '../../../lib/command.ts';
import { git } from '../../../lib/git.ts';

/**
 * The harness paths that the checks of the tool read: its code with its packages and vendored files, its settings and
 * schemas, and the harness documents that check code reads (the document format check, the QA command check, the game
 * settings check of the engine, and the module order that `ogw generate` writes at an instance start).
 */
export const CHECK_INPUT_PATHS = [
  'tools/',
  'schemas/',
  'settings.json',
  'skills/game-design/SKILL.md',
  'skills/client-core/SKILL.md',
  'skills/client-core/modules/qa-core.md',
  'skills/build/engines/',
] as const;

/** The paths under `tools/` that no check reads: the defining document of the tool and its tests. */
export const CHECK_INPUT_EXCLUDED = ['tools/ogw.md', 'tools/test'] as const;

/** The check inputs key of `commit` of the harness repo `harness`: the SHA-256 of the tree entries of `CHECK_INPUT_PATHS`. */
export async function checkInputs(ctx: Context, harness: string, commit: string): Promise<string> {
  const listed = await git(harness, ['ls-tree', '--full-tree', commit, '--', ...CHECK_INPUT_PATHS], { env: ctx.env });
  const lines = listed.split('\n').filter((line) => line !== '' && !(CHECK_INPUT_EXCLUDED as readonly string[]).includes(line.split('\t')[1] ?? ''));
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}
