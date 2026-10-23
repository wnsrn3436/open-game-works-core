import { rm, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { ESLint, type Linter } from 'eslint';
import { OgwError } from '../../../lib/errors.ts';
import { typescriptLintConfig } from '../../code/eslint-options.ts';
import { runGdlint } from '../../code/gdscript-checks.ts';
import { typescriptCompilerOptions } from '../../code/ts-options.ts';
import { toolProgram } from '../../env/api.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isServerContentTs } from './lib/files.ts';
import { serverRootFiles } from './type-check.ts';
import { newPrivateTempFolder } from '../../../lib/secret-files.ts';

/**
 * lint: content code fails the lint of `ogw code check`. GDScript: harness settings `tools.gdtoolkit` `gdlint`
 * with only the name rules on (`client-core` Godot `## GDScript`). TypeScript: typescript-eslint `strict-type-checked`
 * and ESLint `complexity` with the upper bound harness settings `codeCheck.maxComplexity`.
 */
export const NAME = 'lint';

async function gdscript(sc: StaticContext): Promise<Finding[]> {
  const files = sc.filter(isClientContentGd);
  if (files.length === 0) return [];
  const gdlint = await toolProgram(sc.ctx, 'gdtoolkit');
  if (gdlint === null) throw new OgwError('harness settings tools.gdtoolkit (gdlint) is not installed on this host');
  return (await runGdlint(gdlint, sc.root, files, sc.ctx.env)).map((e) => finding(NAME, at(e.path, e.line), e.message));
}

async function typescript(sc: StaticContext): Promise<Finding[]> {
  const files = sc.filter(isServerContentTs);
  if (files.length === 0) return [];
  const settings = await sc.ctx.settings();
  const dir = await newPrivateTempFolder('ogw-eslint-', sc.ctx.env);
  try {
    const tsconfig = join(dir, 'tsconfig.json');
    await writeFile(tsconfig, JSON.stringify({ compilerOptions: typescriptCompilerOptions(), files: serverRootFiles(sc.root, files) }));
    const config: Linter.Config[] = [
      ...typescriptLintConfig(sc.root, settings.codeCheck.maxComplexity),
      { languageOptions: { parserOptions: { projectService: false, project: [tsconfig], tsconfigRootDir: dir } } },
    ];
    const eslint = new ESLint({ cwd: sc.root, overrideConfigFile: true, overrideConfig: config });
    const results = await eslint.lintFiles(files.map((f) => join(sc.root, f)));
    const out: Finding[] = [];
    for (const result of results) {
      const path = relative(sc.root, result.filePath).split(sep).join('/');
      for (const m of result.messages) {
        if (m.severity === 2) out.push(finding(NAME, at(path, m.line), `${m.ruleId ?? 'error'} ${m.message}`));
      }
    }
    return out;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const [gd, tsFindings] = await Promise.all([gdscript(sc), typescript(sc)]);
  return [...gd, ...tsFindings];
}
