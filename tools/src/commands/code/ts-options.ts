import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** ogw's own `tools/tsconfig.json`. */
export const OGW_TSCONFIG = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'tsconfig.json');

/** The folder that holds ogw's own `@types/*` packages. */
export function typeRootsDir(): string {
  const require = createRequire(import.meta.url);
  return dirname(dirname(require.resolve('@types/node/package.json')));
}

/**
 * TypeScript compiler options of every TypeScript check ogw runs (`ogw code check` type check and lint, static
 * check `type check` and `lint`): the `compilerOptions` of ogw's own `tools/tsconfig.json`, with `typeRoots` at
 * ogw's `@types` so that `types` resolves to ogw's own packages. The checked code's config files are not used.
 */
export function typescriptCompilerOptions(): Record<string, unknown> {
  const config = JSON.parse(readFileSync(OGW_TSCONFIG, 'utf8')) as { compilerOptions?: Record<string, unknown> };
  return { ...config.compilerOptions, typeRoots: [typeRootsDir()] };
}
