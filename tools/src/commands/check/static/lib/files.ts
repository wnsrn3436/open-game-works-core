/** Which game repo files belong to which code group. Paths are game-repo relative with `/`. */

const CLIENT_NOT_CONTENT = [
  'client/core/', 'client/generated/', 'client/dev/generated/', 'client/addons/', 'client/.godot/', 'client/build/',
  'client/android/', 'client/ios/', 'client/resource/',
];

/** Files `ogw generate` writes in `client/boot/`; they are generated code, not content code. */
const CLIENT_GENERATED_FILES = new Set(['client/boot/boot.gd']);

/** `server/` folders outside server content code: core, generated code and DEV code (`server-content` `## folder`), build output and packages. */
const SERVER_NOT_CONTENT = ['server/core/', 'server/generated/', 'server/dev/', 'server/build/', 'server/node_modules/'];

function under(path: string, prefixes: readonly string[]): boolean {
  return prefixes.some((p) => path.startsWith(p));
}

/** Client content code: `client/` `.gd` files outside core, generated code and engine folders. */
export function isClientContentGd(path: string): boolean {
  return path.startsWith('client/') && path.endsWith('.gd') && !under(path, CLIENT_NOT_CONTENT) && !CLIENT_GENERATED_FILES.has(path);
}

/** Every client `.gd` file Godot sees (core and generated included). */
export function isClientGd(path: string): boolean {
  return path.startsWith('client/') && path.endsWith('.gd') && !under(path, ['client/addons/', 'client/.godot/', 'client/build/', 'client/android/', 'client/ios/', 'client/resource/']);
}

export function isClientDev(path: string): boolean {
  return path.startsWith('client/dev/');
}

export function isClientTest(path: string): boolean {
  return path.startsWith('client/tests/');
}

/** Server content code: `server/` `.ts` files outside `server/core/`, `server/generated/` and `server/dev/`. */
export function isServerContentTs(path: string): boolean {
  return path.startsWith('server/') && /\.(ts|mts|cts)$/.test(path) && !under(path, SERVER_NOT_CONTENT);
}

export function isServerTest(path: string): boolean {
  return path.startsWith('server/tests/');
}

const CLIENT_CONSTANTS = /^client\/(common|features\/[^/]+)\/constants\.gd$/;

/** The client constants files (Godot `## feature folder`) and `server/common/constants.ts`. */
export function isConstantsFile(path: string): boolean {
  return CLIENT_CONSTANTS.test(path) || path === 'server/common/constants.ts';
}

/** Feature name of a `client/features/<feature>/` path, or null. */
export function featureOf(path: string): string | null {
  const m = /^client\/features\/([^/]+)\//.exec(path);
  return m ? (m[1] as string) : null;
}

/** `res://` path of a client file, or `res://resource/...` for a `resource/` file. */
export function resPath(path: string): string {
  if (path.startsWith('client/')) return `res://${path.slice('client/'.length)}`;
  return `res://${path}`;
}

/** Game-repo path of a `res://` path. */
export function repoPath(res: string): string | null {
  if (!res.startsWith('res://')) return null;
  const rest = res.slice('res://'.length);
  if (rest.startsWith('resource/')) return rest;
  return `client/${rest}`;
}

/** snake_case to PascalCase. */
export function pascal(snake: string): string {
  return snake
    .split('_')
    .filter((part) => part.length > 0)
    .map((part) => (part[0] as string).toUpperCase() + part.slice(1))
    .join('');
}

/** PascalCase or CONSTANT_CASE to snake_case. */
export function snake(name: string): string {
  if (/^[A-Z0-9_]+$/.test(name)) return name.toLowerCase();
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z])([A-Z][a-z])/g, '$1_$2')
    .toLowerCase();
}

export function isSnakeCase(text: string): boolean {
  return /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/.test(text);
}
