import { typescriptCompilerOptions } from '../../../code/ts-options.ts';
import { ts } from './ts-source.ts';

/** The shared TypeScript options of `ogw` (`code/ts-options.ts`) as compiler API options. */
export function compilerOptions(basePath: string): ts.CompilerOptions {
  const { options, errors } = ts.convertCompilerOptionsFromJson(typescriptCompilerOptions(), basePath);
  if (errors.length > 0) throw new Error(ts.flattenDiagnosticMessageText(errors[0]?.messageText ?? '', '\n'));
  return options;
}
