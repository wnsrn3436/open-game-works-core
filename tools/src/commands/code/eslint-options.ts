import tseslint from 'typescript-eslint';
import type { Linter } from 'eslint';

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
