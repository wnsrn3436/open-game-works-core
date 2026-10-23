import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The harness repo `open-game-works-core/`. Tests point `OGW_HARNESS_ROOT` at a temporary copy.
 */
export function harnessRoot(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.OGW_HARNESS_ROOT;
  if (override) return resolve(override);
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/** The workspace root is the parent folder of the harness repo. */
export function workspaceRoot(env: NodeJS.ProcessEnv = process.env): string {
  return dirname(harnessRoot(env));
}

/** Absolute path of `src/cli.ts`, used to start background jobs. */
export function cliEntry(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', 'cli.ts');
}

/** True when `child` is `parent` or inside it. */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

/** The path without its extension. A name that starts with its only dot (`.md`) has no extension. */
export function withoutExtension(path: string): string {
  const slash = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? path.slice(0, dot) : path;
}

/** The extension with its dot, or an empty string. */
export function extensionOf(path: string): string {
  return path.slice(withoutExtension(path).length);
}

/** Path segments of `child` below `parent`, or null when it is not inside. */
export function segmentsBelow(parent: string, child: string): string[] | null {
  if (!isInside(parent, child)) return null;
  const rel = relative(resolve(parent), resolve(child));
  return rel === '' ? [] : rel.split(sep);
}
