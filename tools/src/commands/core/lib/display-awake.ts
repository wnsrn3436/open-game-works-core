import { killTree, spawnTracked } from '../../../lib/proc.ts';

/** The `caffeinate` arguments of the display sleep assertion held for the process `pid` (ogw.md `### Godot core test`). */
export function caffeinateArgs(pid: number): string[] {
  return ['-d', '-i', '-w', String(pid)];
}

/**
 * Holds a display sleep assertion while this process runs on macOS, so that an idle display does not turn off during a
 * core test run; a screen the human locked stays locked. Returns the release. On another OS it holds nothing, and a
 * host without `caffeinate` runs without it.
 */
export function holdDisplayAwake(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): () => void {
  if (platform !== 'darwin') return () => undefined;
  const child = spawnTracked('caffeinate', caffeinateArgs(process.pid), { env, stdio: 'ignore' });
  child.on('error', () => undefined);
  return () => {
    if (child.exitCode === null && child.signalCode === null) killTree(child);
  };
}

/** What `ogw core test` calls to hold the assertion; tests replace it. */
export const awakeDeps = { hold: holdDisplayAwake };
