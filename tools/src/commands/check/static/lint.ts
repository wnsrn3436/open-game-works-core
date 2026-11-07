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
import { offThread } from './lib/off-thread.ts';
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

/**
 * The type-aware ESLint findings of server files of the checkout `root`, with the tsconfig of those files in `dir`. Its
 * work is synchronous: the static check runs it in a worker thread (`offThread`).
 */
export async function typescriptLintFindings(root: string, files: readonly string[], maxComplexity: number, dir: string): Promise<Finding[]> {
  const tsconfig = join(dir, 'tsconfig.json');
  await writeFile(tsconfig, JSON.stringify({ compilerOptions: typescriptCompilerOptions(), files: serverRootFiles(root, files) }));
  const config: Linter.Config[] = [
    ...typescriptLintConfig(root, maxComplexity),
    { languageOptions: { parserOptions: { projectService: false, project: [tsconfig], tsconfigRootDir: dir } } },
  ];
  const eslint = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: config });
  const results = await eslint.lintFiles(files.map((f) => join(root, f)));
  const out: Finding[] = [];
  for (const result of results) {
    const path = relative(root, result.filePath).split(sep).join('/');
    for (const m of result.messages) {
      if (m.severity === 2) out.push(finding(NAME, at(path, m.line), `${m.ruleId ?? 'error'} ${m.message}`));
    }
  }
  return out;
}

async function typescript(sc: StaticContext): Promise<Finding[]> {
  const files = sc.filter(isServerContentTs);
  if (files.length === 0) return [];
  const settings = await sc.ctx.settings();
  const dir = await newPrivateTempFolder('ogw-eslint-', sc.ctx.env);
  try {
    return await offThread({ kind: 'eslint', root: sc.root, files: [...files], maxComplexity: settings.codeCheck.maxComplexity, dir });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const [gd, tsFindings] = await Promise.all([gdscript(sc), typescript(sc)]);
  return [...gd, ...tsFindings];
}
