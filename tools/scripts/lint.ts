// Lints ogw with the same config `ogw code check tool` uses. Usage: node scripts/lint.ts [<path>...] (default: src and test)
import { ESLint } from 'eslint';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { typescriptLintConfig } from '../src/commands/code/eslint-options.ts';

const tools = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const settings = JSON.parse(readFileSync(join(tools, '..', 'settings.json'), 'utf8')) as {
  codeCheck: { maxComplexity: number };
};
const eslint = new ESLint({
  cwd: tools,
  overrideConfigFile: true,
  overrideConfig: typescriptLintConfig(tools, settings.codeCheck.maxComplexity),
});
const targets = process.argv.slice(2);
const results = await eslint.lintFiles(targets.length > 0 ? targets : ['src/**/*.ts', 'test/**/*.ts']);
const formatter = await eslint.loadFormatter('stylish');
const text = await formatter.format(results);
if (text) process.stdout.write(text);
process.exitCode = results.some((r) => r.errorCount > 0) ? 1 : 0;
