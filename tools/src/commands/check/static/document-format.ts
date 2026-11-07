import { LIST_PATH, parseKey } from '../../resource/lib/list.ts';
import { cell, column, parseTable, section, unquote, type Table } from '../../loop/lib/markdown.ts';
import { absence, at, finding, type Finding, type StaticContext } from './lib/context.ts';

/**
 * document format (`game-design` `## brief`, `## design doc`, `## play guide`): the `##` headings of `brief.md`,
 * `design.md` and `play-guide.md` are those of the heading table of their section, each once, in table order; in
 * `design.md` and `play-guide.md` each `##` heading has a non-empty line before the next `##` heading. `brief.md`
 * `## genre conventions` has a table with the columns `convention`, `decision`, `reason` whose `decision` cells are
 * `accept`, `twist` or `reject` and not all `accept`, and `## prohibitions` has two or more top-level list items.
 * `play-guide.md` `## play mode` has a table with the columns `scene`, `mode`, `step ms`: `scene` a `scene` key of
 * `resources.csv`, `mode` `free`, `step` or `script`, `step ms` an integer of 1 or more for `step` and empty otherwise.
 * Headings inside code fences are not headings.
 */
export const NAME = 'document format';

const DESIGN_SKILL = 'skills/game-design/SKILL.md';

interface Doc {
  path: string;
  /** The `game-design` section that holds its heading table. */
  section: string;
  /** Every `##` heading has content before the next `##` heading. */
  content: boolean;
}

const DOCS: readonly Doc[] = [
  { path: 'brief.md', section: 'brief', content: false },
  { path: 'design.md', section: 'design doc', content: true },
  { path: 'play-guide.md', section: 'play guide', content: true },
];

/** The headings of the heading table of a `game-design` section, without `## `. */
export function tableHeadings(skill: string, name: string): string[] {
  const table = parseTable(section(skill, name) ?? []);
  if (!table) return [];
  const col = column(table, 'heading');
  return table.rows.map((row) => unquote(row.cells[col] ?? '').replace(/^##\s+/, ''));
}

interface Heading {
  text: string;
  /** 0-based line index. */
  index: number;
}

/** The `##` headings of a markdown file outside code fences. */
function headingsOf(lines: readonly string[]): Heading[] {
  const out: Heading[] = [];
  let fence = false;
  lines.forEach((line, index) => {
    if (line.trimStart().startsWith('```')) fence = !fence;
    else if (!fence && /^## /.test(line)) out.push({ text: line.slice(3).trim(), index });
  });
  return out;
}

function headingFindings(doc: Doc, lines: readonly string[], expected: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const headings = headingsOf(lines);
  const seen = new Set<string>();
  let last = -1;
  for (const [i, h] of headings.entries()) {
    const where = at(doc.path, h.index + 1);
    const position = expected.indexOf(h.text);
    if (position === -1) out.push(finding(NAME, where, `\`## ${h.text}\` is not a heading of ${doc.path} (game-design \`## ${doc.section}\`); put its content under one of them`));
    else if (seen.has(h.text)) out.push(finding(NAME, where, `\`## ${h.text}\` is repeated`));
    else if (position < last) out.push(finding(NAME, where, `\`## ${h.text}\` comes after \`## ${expected[last] as string}\`; the headings follow the order of game-design \`## ${doc.section}\``));
    if (position !== -1 && !seen.has(h.text)) {
      seen.add(h.text);
      last = Math.max(last, position);
    }
    const end = headings[i + 1]?.index ?? lines.length;
    if (doc.content && lines.slice(h.index + 1, end).every((l) => l.trim() === '')) out.push(finding(NAME, where, `\`## ${h.text}\` has no content; write \`none\` under a heading with nothing to say`));
  }
  for (const h of expected) if (!seen.has(h)) out.push(absence(NAME, at(doc.path, 1), `\`## ${h}\` is missing (game-design \`## ${doc.section}\`)`));
  return out;
}

/** The lines of a `##` section, with the 0-based index of its heading line; null when the heading is missing. */
function sectionOf(lines: readonly string[], heading: string): { start: number; lines: string[] } | null {
  const h = headingsOf(lines).find((x) => x.text === heading);
  if (!h) return null;
  const next = headingsOf(lines).find((x) => x.index > h.index);
  return { start: h.index, lines: lines.slice(h.index + 1, next?.index ?? lines.length) };
}

function hasColumns(table: Table | null, names: readonly string[]): table is Table {
  return table !== null && names.every((n) => column(table, n) !== -1);
}

const DECISIONS = new Set(['accept', 'twist', 'reject']);

function briefFindings(lines: readonly string[]): Finding[] {
  const out: Finding[] = [];
  const conventions = sectionOf(lines, 'genre conventions');
  if (conventions) {
    const where = at('brief.md', conventions.start + 1);
    const table = parseTable(conventions.lines);
    if (!hasColumns(table, ['convention', 'decision', 'reason'])) out.push(finding(NAME, where, '`## genre conventions` has no table with the columns `convention`, `decision`, `reason`'));
    else {
      const col = column(table, 'decision');
      for (const row of table.rows) {
        const decision = cell(row, col);
        if (!DECISIONS.has(decision)) out.push(finding(NAME, at('brief.md', conventions.start + row.line + 2), `decision \`${decision}\` is not one of \`accept\`, \`twist\`, \`reject\``));
      }
      if (table.rows.every((row) => cell(row, col) === 'accept')) out.push(finding(NAME, where, '`## genre conventions` has no `twist` or `reject` decision; a brief that accepts every convention is rewritten'));
    }
  }
  const prohibitions = sectionOf(lines, 'prohibitions');
  if (prohibitions) {
    let fence = false;
    const items = prohibitions.lines.filter((l) => {
      if (l.trimStart().startsWith('```')) fence = !fence;
      return !fence && /^(?:[-*+]|[0-9]+\.) /.test(l);
    }).length;
    if (items < 2) out.push(finding(NAME, at('brief.md', prohibitions.start + 1), `\`## prohibitions\` has ${String(items)} top-level list items; it lists two or more prohibitions`));
  }
  return out;
}

const MODES = new Set(['free', 'step', 'script']);

async function playModeFindings(sc: StaticContext, lines: readonly string[]): Promise<Finding[]> {
  const mode = sectionOf(lines, 'play mode');
  if (!mode) return [];
  const table = parseTable(mode.lines);
  if (!hasColumns(table, ['scene', 'mode', 'step ms'])) return [finding(NAME, at('play-guide.md', mode.start + 1), '`## play mode` has no table with the columns `scene`, `mode`, `step ms`')];
  const list = await sc.headerTable(LIST_PATH);
  const scenes = new Set((list?.rows ?? []).map((r) => r.values.key ?? '').filter((k) => parseKey(k)?.type === 'scene'));
  const out: Finding[] = [];
  const [sceneCol, modeCol, stepCol] = [column(table, 'scene'), column(table, 'mode'), column(table, 'step ms')];
  for (const row of table.rows) {
    const where = at('play-guide.md', mode.start + row.line + 2);
    const [scene, m, step] = [cell(row, sceneCol), cell(row, modeCol), cell(row, stepCol)];
    if (!scenes.has(scene)) out.push(finding(NAME, where, `scene \`${scene}\` is not the key of a \`scene\` row of ${LIST_PATH}`));
    if (!MODES.has(m)) out.push(finding(NAME, where, `mode \`${m}\` is not one of \`free\`, \`step\`, \`script\``));
    else if (m === 'step' && !/^[1-9][0-9]*$/.test(step)) out.push(finding(NAME, where, `step ms \`${step}\` of a \`step\` scene is not an integer of 1 or more`));
    else if (m !== 'step' && step !== '') out.push(finding(NAME, where, `step ms \`${step}\` is for a \`step\` scene only; leave it empty for \`${m}\``));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const skill = await sc.doc(DESIGN_SKILL);
  const out: Finding[] = [];
  for (const doc of DOCS) {
    if (!sc.has(doc.path)) continue;
    const lines = (await sc.text(doc.path)).split(/\r?\n/);
    out.push(...headingFindings(doc, lines, tableHeadings(skill, doc.section)));
    if (doc.path === 'brief.md') out.push(...briefFindings(lines));
    if (doc.path === 'play-guide.md') out.push(...(await playModeFindings(sc, lines)));
  }
  return out;
}
