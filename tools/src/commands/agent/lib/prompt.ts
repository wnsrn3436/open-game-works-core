import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { readText } from '../../../lib/fsx.ts';
import { section } from '../../../lib/markdown.ts';
import type { Role } from '../../../lib/settings.ts';

/** `AGENTS.md` sections put before the agent definition, in this order. */
export const AGENTS_SECTIONS = ['purpose', 'terms', 'repo', 'layer', 'environment', 'rules'] as const;

/** Roles whose prompt has no `AGENTS.md` sections. */
const NO_SECTIONS: readonly Role[] = ['play', 'judge'];

/** A section: its `## <name>` line and the lines of `section`, ending with a newline. */
export function markdownSection(text: string, name: string): string | null {
  const lines = section(text, name);
  return lines === null ? null : `${[`## ${name}`, ...lines].join('\n')}\n`;
}

/** Cells of a markdown table line; `\|` does not split. */
export function tableCells(line: string): string[] {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map((cell) => cell.trim());
}

/** Replaces the leading `../` of markdown link targets with the harness repo path and `/`. */
export function absoluteLinks(text: string, harness: string): string {
  return text.replace(/\]\(\.\.\//g, `](${harness}/`);
}

export interface PromptParams {
  input: string;
  output: string;
  run: string | null;
  iteration: number | null;
}

/** The values `ogw agent` passes with the prompt. */
export function paramsBlock(params: PromptParams): string {
  const lines = ['## ogw agent', '', `- input: ${params.input}`, `- output: ${params.output}`];
  if (params.run !== null) lines.push(`- run: ${params.run}`);
  if (params.iteration !== null) lines.push(`- iteration: ${String(params.iteration)}`);
  return `${lines.join('\n')}\n`;
}

/** The prompt of an agent of `role`: `AGENTS.md` sections (not for play and judge), `agents/<role>.md`, and the values. */
export async function buildPrompt(harness: string, role: Role, params: PromptParams): Promise<string> {
  const definition = absoluteLinks(await readText(join(harness, 'agents', `${role}.md`)), harness);
  const parts: string[] = [];
  if (!NO_SECTIONS.includes(role)) {
    const agentsMd = await readText(join(harness, 'AGENTS.md'));
    for (const name of AGENTS_SECTIONS) {
      const section = markdownSection(agentsMd, name);
      if (section === null) throw new OgwError(`AGENTS.md has no section ## ${name}`);
      parts.push(section);
    }
  }
  parts.push(definition.endsWith('\n') ? definition : `${definition}\n`);
  parts.push(paramsBlock(params));
  return parts.join('\n');
}
