import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OGW_TSCONFIG, typeRootsDir, typescriptCompilerOptions } from '../../../src/commands/code/ts-options.ts';

describe('typescriptCompilerOptions', () => {
  it('is the compilerOptions of ogw tools/tsconfig.json with typeRoots at ogw @types', () => {
    expect(OGW_TSCONFIG).toBe(join(import.meta.dirname, '..', '..', '..', 'tsconfig.json'));
    const own = (JSON.parse(readFileSync(OGW_TSCONFIG, 'utf8')) as { compilerOptions: Record<string, unknown> }).compilerOptions;
    expect(typescriptCompilerOptions()).toEqual({ ...own, typeRoots: [typeRootsDir()] });
    expect(typescriptCompilerOptions()).toMatchObject({ strict: true, noUncheckedIndexedAccess: true, verbatimModuleSyntax: true });
  });

  it('finds the @types folder of ogw', () => {
    expect(typeRootsDir()).toBe(join(import.meta.dirname, '..', '..', '..', 'node_modules', '@types'));
  });
});
