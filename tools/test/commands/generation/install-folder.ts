// The install folder of a generation method in tests: `.ogw/generation-install/<method>/<install key>/` (ogw.md `## generation install`).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { methodDir } from '../../../src/commands/generation/lib/install.ts';
import { createContext } from '../../../src/lib/command.ts';
import type { GenerationMethod } from '../../../src/lib/settings.ts';
import type { TestWorkspace } from '../../helpers/workspace.ts';

/** A method as a test gives it to harness settings. */
export type MethodLike = { name: string } & Record<string, unknown>;

/** The install folder of `method` on the checkout `env` points at (its `OGW_HARNESS_ROOT`). */
export function installFolder(ws: TestWorkspace, method: MethodLike, env: NodeJS.ProcessEnv = ws.env): Promise<string> {
  const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
  return methodDir(ctx, method as unknown as GenerationMethod);
}

/**
 * Writes the `installed.json` that `ogw generation install` leaves for `method` into its install folder, with `fields`
 * over an install of no files, and returns the folder.
 */
export async function writeInstall(ws: TestWorkspace, method: MethodLike, fields: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = ws.env): Promise<string> {
  const dir = await installFolder(ws, method, env);
  mkdirSync(dir, { recursive: true });
  const pins = (method.pins ?? []) as unknown[];
  writeFileSync(join(dir, 'installed.json'), JSON.stringify({ name: method.name, pins: JSON.stringify(pins), git: [], hf: [], files: null, python: null, cli: null, skill: null, ...fields }));
  return dir;
}

/** The method `name` of the harness settings of the checkout `env` points at. */
export function settingsMethod(ws: TestWorkspace, name: string, env: NodeJS.ProcessEnv = ws.env): MethodLike {
  const harness = env.OGW_HARNESS_ROOT ?? ws.harness;
  const methods = (JSON.parse(readFileSync(join(harness, 'settings.json'), 'utf8')) as { resourceGeneration: MethodLike[] }).resourceGeneration;
  const method = methods.find((m) => m.name === name);
  if (method === undefined) throw new Error(`no method ${name} in ${harness}/settings.json`);
  return method;
}

/** The install folder of the method `name` of the harness settings of the checkout `env` points at. */
export function installFolderOf(ws: TestWorkspace, name: string, env: NodeJS.ProcessEnv = ws.env): Promise<string> {
  return installFolder(ws, settingsMethod(ws, name, env), env);
}
