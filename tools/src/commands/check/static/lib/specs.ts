import { OgwError } from '../../../../lib/errors.ts';
import { section } from '../../../../lib/markdown.ts';
import { gameCoreSpec } from '../../../generate/api.ts';
import type { StaticContext } from './context.ts';

/** Reading facts the static checks need from the harness spec documents and the core spec. */

/** Cells of a markdown table row, without the outer pipes. Escaped `\|` stays in the cell. */
export function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((c) => c.trim());
}

/** Splits a cell at top-level `, ` (outside parentheses and code spans). */
export function splitTopLevel(cell: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let code = false;
  let cur = '';
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i] as string;
    if (ch === '`') code = !code;
    if (!code && ch === '(') depth++;
    if (!code && ch === ')') depth = Math.max(0, depth - 1);
    if (!code && depth === 0 && ch === ',' && cell[i + 1] === ' ') {
      parts.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

function codeSpan(text: string): string | null {
  const m = /^`([^`]+)`/.exec(text.trim());
  return m ? (m[1] as string) : null;
}

/**
 * Client core operations whose inputs include a translation key: `Module.operation` → input positions
 * (0-based), from the `operations` of the game's core version `core-spec.json`.
 */
export async function translationKeyInputs(sc: StaticContext): Promise<Map<string, number[]>> {
  const out = new Map<string, number[]>();
  for (const module of (await gameCoreSpec(sc.ctx, sc.game)).modules) {
    if (module.side !== 'client') continue;
    for (const op of module.operations) {
      const positions = op.inputs.flatMap((kind, i) => (kind === 'translationKey' ? [i] : []));
      if (positions.length > 0) out.set(`${module.name}.${op.name}`, positions);
    }
  }
  return out;
}

export type BuiltinKind = 'input' | 'setup' | 'step' | 'other';

/** `QACore` built-in commands and their mark (`qa-core` `### built-in command`). */
export async function qaBuiltins(sc: StaticContext): Promise<Map<string, BuiltinKind>> {
  return parseQaBuiltins(await sc.doc('skills/client-core/modules/qa-core.md'));
}

/** `QACore` built-in commands and their mark, read from the text of qa-core.md. */
export function parseQaBuiltins(doc: string): Map<string, BuiltinKind> {
  const out = new Map<string, BuiltinKind>();
  for (const line of section(doc, 'built-in command', 3) ?? []) {
    if (!line.startsWith('| `')) continue;
    const cells = tableCells(line);
    const name = codeSpan(cells[0] ?? '');
    if (name === null) continue;
    const work = cells[2] ?? '';
    const kind: BuiltinKind = work.startsWith('input.') ? 'input' : work.startsWith('setup.') ? 'setup' : work.startsWith('step.') ? 'step' : 'other';
    out.set(name, kind);
  }
  if (out.size === 0) throw new OgwError('cannot read the QACore built-in command table of qa-core.md');
  return out;
}
