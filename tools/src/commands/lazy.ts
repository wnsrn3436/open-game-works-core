import type { CommandDef } from '../lib/command.ts';

type Loader = () => Promise<{ commands: readonly CommandDef[] }>;

/**
 * The command folders by the first word of their commands, loaded only when a command of that word runs, so that one
 * call does not load the modules of every command. `index.ts` holds the same folders loaded at once.
 */
export const COMMAND_FOLDERS: Readonly<Record<string, Loader>> = {
  loop: () => import('./loop/index.ts'),
  game: () => import('./game/index.ts'),
  settings: () => import('./settings/index.ts'),
  secret: () => import('./secret/index.ts'),
  env: () => import('./env/index.ts'),
  generation: () => import('./generation/index.ts'),
  instance: () => import('./instance/index.ts'),
  agent: () => import('./agent/index.ts'),
  job: () => import('./job/index.ts'),
  input: () => import('./input/index.ts'),
  capture: () => import('./capture/index.ts'),
  log: () => import('./log/index.ts'),
  telemetry: () => import('./telemetry/index.ts'),
  'step-mode': () => import('./step-mode/index.ts'),
  step: () => import('./step/index.ts'),
  command: () => import('./command/index.ts'),
  frames: () => import('./frames/index.ts'),
  check: () => import('./check/index.ts'),
  measure: () => import('./measure/index.ts'),
  simulate: () => import('./simulate/index.ts'),
  contract: () => import('./contract/index.ts'),
  data: () => import('./data/index.ts'),
  translation: () => import('./translation/index.ts'),
  resource: () => import('./resource/index.ts'),
  build: () => import('./build/index.ts'),
  deploy: () => import('./deploy/index.ts'),
  core: () => import('./core/index.ts'),
  code: () => import('./code/index.ts'),
  review: () => import('./review/index.ts'),
  generate: () => import('./generate/index.ts'),
  meta: () => import('./meta/index.ts'),
  admin: () => import('./admin/index.ts'),
  clone: () => import('./clone/index.ts'),
  docs: () => import('./docs/index.ts'),
  video: () => import('./video/index.ts'),
};

/** The commands one argv can run: those of the folder of its first word, or every command when that word names no folder. */
export async function commandsFor(word: string | undefined): Promise<readonly CommandDef[]> {
  // the job supervisor runs no command
  if (word === '__job-supervise') return [];
  const load = word === undefined ? undefined : COMMAND_FOLDERS[word];
  if (load !== undefined) return (await load()).commands;
  return (await import('./index.ts')).commands;
}
