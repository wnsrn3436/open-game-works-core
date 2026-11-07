import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as documentFormat from '../../../../src/commands/check/static/document-format.ts';
import { harnessRoot } from '../../../../src/lib/paths.ts';
import { absentLines, lines, memContext } from './helpers.ts';

const SKILL = readFileSync(join(harnessRoot(), 'skills', 'game-design', 'SKILL.md'), 'utf8');
const BRIEF = documentFormat.tableHeadings(SKILL, 'brief');
const DESIGN = documentFormat.tableHeadings(SKILL, 'design doc');
const GUIDE = documentFormat.tableHeadings(SKILL, 'play guide');

/** A document with every heading of `headings` in order, each with `body` unless `bodies` gives another. */
function docOf(headings: readonly string[], bodies: Record<string, string> = {}): string {
  return headings.map((h) => `## ${h}\n\n${bodies[h] ?? 'none'}\n`).join('\n');
}

const CONVENTIONS = '| convention | decision | reason |\n|---|---|---|\n| endless run | accept | core |\n| ads | reject | premium |';
const PROHIBITIONS = '- No ads\n- No unlocks';
const LIST = ['key,description,spec,status,method,source,license,attribution,sha256', 'scene/title/title,x,,final,,,,,', 'scene/play/play,x,,final,,,,,', 'prefab/play/hud,x,,final,,,,,', ''].join('\n');
const PLAY_MODE = '| scene | mode | step ms |\n|---|---|---|\n| `scene/title/title` | `free` | |\n| `scene/play/play` | `step` | 50 |';

function good(): Record<string, string> {
  return {
    'resource/resources.csv': LIST,
    'brief.md': docOf(BRIEF, { 'genre conventions': CONVENTIONS, prohibitions: PROHIBITIONS }),
    'design.md': docOf(DESIGN),
    'play-guide.md': docOf(GUIDE, { 'play mode': PLAY_MODE }),
  };
}

describe('document format', () => {
  it('reads the heading tables of game-design', () => {
    expect(BRIEF.slice(0, 2)).toEqual(['player fantasy', 'emotion']);
    expect(DESIGN).toContain('code map');
    expect(GUIDE.at(-1)).toBe('play mode');
  });

  it('passes documents with every heading in order and their formats', async () => {
    expect(await documentFormat.run(memContext(good()))).toEqual([]);
    expect(await documentFormat.run(memContext({}))).toEqual([]);
  });

  it('fails a heading that is missing, repeated, out of order or not in the table, and a heading without content', async () => {
    const [a, b, c, ...rest] = DESIGN as [string, string, string, ...string[]];
    const design = [`## ${b}`, '', 'x', '', `## ${a}`, '', 'x', '', '## battle feedback', '', 'x', '', `## ${a}`, '', 'x', '', '```', `## ${c}`, '```', ...rest.flatMap((h) => [`## ${h}`, '', 'x', '']), '### under', 'x'].join('\n');
    const guide = docOf(GUIDE, { 'play mode': PLAY_MODE }).replace('## goal\n\nnone\n', '## goal\n\n### sub\n').replace('## controls\n\nnone\n', '## controls\n\n');
    const found = await documentFormat.run(memContext({ ...good(), 'design.md': design, 'play-guide.md': guide }));
    expect(lines(found)).toEqual([
      `design.md:1 | document format: \`## ${c}\` is missing (game-design \`## design doc\`)`,
      `design.md:5 | document format: \`## ${a}\` comes after \`## ${b}\`; the headings follow the order of game-design \`## design doc\``,
      'design.md:9 | document format: `## battle feedback` is not a heading of design.md (game-design `## design doc`); put its content under one of them',
      `design.md:13 | document format: \`## ${a}\` is repeated`,
      'play-guide.md:5 | document format: `## controls` has no content; write `none` under a heading with nothing to say',
    ]);
    expect(absentLines(found)).toEqual([`design.md:1 | document format: \`## ${c}\` is missing (game-design \`## design doc\`)`]);
  });

  it('does not ask a brief heading for content', async () => {
    expect(await documentFormat.run(memContext({ ...good(), 'brief.md': docOf(BRIEF, { 'genre conventions': CONVENTIONS, prohibitions: PROHIBITIONS, emotion: '' }) }))).toEqual([]);
  });

  it('fails brief genre conventions without the table, with another decision or every decision accept, and fewer than two prohibitions', async () => {
    const brief = (conventions: string, prohibitions: string): string => docOf(BRIEF, { 'genre conventions': conventions, prohibitions });
    const lineOf = (text: string, heading: string): number => text.split('\n').indexOf(`## ${heading}`) + 1;
    const at = (heading: string): number => lineOf(brief(CONVENTIONS, PROHIBITIONS), heading);
    const run = async (text: string): Promise<string[]> => lines(await documentFormat.run(memContext({ ...good(), 'brief.md': text })));
    const bad = brief('- endless run: accept', '- No ads\n  - nested\n```\n- in code\n```');
    expect(await run(bad)).toEqual([
      `brief.md:${String(lineOf(bad, 'genre conventions'))} | document format: \`## genre conventions\` has no table with the columns \`convention\`, \`decision\`, \`reason\``,
      `brief.md:${String(lineOf(bad, 'prohibitions'))} | document format: \`## prohibitions\` has 1 top-level list items; it lists two or more prohibitions`,
    ]);
    const conventions = '| convention | decision | reason |\n|---|---|---|\n| endless run | `accept` | core |\n| ads | keep | premium |';
    expect(await run(brief(conventions, '1. No ads\n2. No unlocks'))).toEqual([
      `brief.md:${String(at('genre conventions') + 5)} | document format: decision \`keep\` is not one of \`accept\`, \`twist\`, \`reject\``,
    ]);
    expect(await run(brief('| convention | decision | reason |\n|---|---|---|\n| endless run | accept | core |', PROHIBITIONS))).toEqual([
      `brief.md:${String(at('genre conventions'))} | document format: \`## genre conventions\` has no \`twist\` or \`reject\` decision; a brief that accepts every convention is rewritten`,
    ]);
    expect(await run(brief('', ''))).toHaveLength(2);
  });

  it('fails a play mode without its table, with an unknown scene, an unknown mode or a step ms that breaks its rule', async () => {
    const guide = (mode: string): string => docOf(GUIDE, { 'play mode': mode });
    const start = guide('').split('\n').indexOf('## play mode') + 1;
    const run = async (text: string): Promise<string[]> => lines(await documentFormat.run(memContext({ ...good(), 'play-guide.md': text })));
    expect(await run(guide('- title: free'))).toEqual([`play-guide.md:${String(start)} | document format: \`## play mode\` has no table with the columns \`scene\`, \`mode\`, \`step ms\``]);
    const rows = [
      '| scene | mode | step ms |',
      '|---|---|---|',
      '| `prefab/play/hud` | free | |',
      '| `scene/menu/menu` | free | |',
      '| `scene/play/play` | step | |',
      '| `scene/play/play` | step | 0 |',
      '| `scene/title/title` | free | 50 |',
      '| `scene/title/title` | walk | |',
      '| `scene/play/play` | script | |',
    ].join('\n');
    const row = (n: number): string => `play-guide.md:${String(start + 4 + n)}`;
    expect(await run(guide(rows))).toEqual([
      `${row(0)} | document format: scene \`prefab/play/hud\` is not the key of a \`scene\` row of resource/resources.csv`,
      `${row(1)} | document format: scene \`scene/menu/menu\` is not the key of a \`scene\` row of resource/resources.csv`,
      `${row(2)} | document format: step ms \`\` of a \`step\` scene is not an integer of 1 or more`,
      `${row(3)} | document format: step ms \`0\` of a \`step\` scene is not an integer of 1 or more`,
      `${row(4)} | document format: step ms \`50\` is for a \`step\` scene only; leave it empty for \`free\``,
      `${row(5)} | document format: mode \`walk\` is not one of \`free\`, \`step\`, \`script\``,
    ]);
  });
});
