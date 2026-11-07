import tseslint from 'typescript-eslint';
import type { ESLint, Linter } from 'eslint';
import { noSwallowedError } from './catch-rule.ts';

/**
 * ESLint config `ogw` passes for TypeScript code: typescript-eslint `strict-type-checked`
 * and the `complexity` rule with the upper bound from harness settings `codeCheck.maxComplexity`.
 * The target code's own config files are not used: `project` names the tsconfig `ogw code check`
 * writes; without it the project service finds the tsconfig (used by `scripts/lint.ts` for ogw itself).
 */
export function typescriptLintConfig(rootDir: string, maxComplexity: number, project?: string): Linter.Config[] {
  const parserOptions = project === undefined ? { projectService: true, tsconfigRootDir: rootDir } : { project, tsconfigRootDir: rootDir };
  return [
    ...(tseslint.configs.strictTypeChecked as Linter.Config[]),
    {
      languageOptions: { parserOptions },
      rules: { complexity: ['error', maxComplexity] },
    },
  ];
}

const OGW_PLUGIN: ESLint.Plugin = { rules: { 'no-swallowed-error': noSwallowedError } };

/**
 * The lint config of the harness tool `tools/` (`ogw code check tool` and `scripts/lint.ts`): `typescriptLintConfig`
 * and, for the code under `src/`, `ogw/no-swallowed-error` (ogw.md `## code check`).
 */
export function toolLintConfig(rootDir: string, maxComplexity: number, project?: string): Linter.Config[] {
  return [
    ...typescriptLintConfig(rootDir, maxComplexity, project),
    { files: ['src/**/*.ts'], plugins: { ogw: OGW_PLUGIN }, rules: { 'ogw/no-swallowed-error': 'error' } },
  ];
}
