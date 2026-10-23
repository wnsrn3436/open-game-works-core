// Harness consistency check items that read every harness document:
// terms, references, writing, English, size.
import { statSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import {
  headingLevel,
  isTableLine,
  linkTargets,
  section,
  withoutCodeSpans,
  type MdLine,
} from '../../core/lib/spec-md.ts';
import { at, isHarnessDoc, type DocFile, type Failure } from './files.ts';

// terms

const SYNONYMS: readonly [string, string][] = [
  ['dummy', 'placeholder resource'],
  ['orchestrator', 'lead agent'],
  ['main agent', 'lead agent'],
  ['subagent', 'sub-agent'],
  ['final asset', 'final resource'],
  ['placeholder asset', 'placeholder resource'],
  ['game config', 'game settings'],
  ['harness config', 'harness settings'],
  ['core config', 'core settings'],
];

const NAME = '[A-Za-z](?:[A-Za-z0-9 -]*[A-Za-z])?';
const DASH_DEFINITION = new RegExp(`^- (${NAME}): `);

/** The term a definition line `- <term>: <definition>` defines, or null. */
export function definedTerm(text: string): string | null {
  const dash = DASH_DEFINITION.exec(text);
  return dash ? (dash[1] as string).toLowerCase() : null;
}

function definitionLines(doc: DocFile): MdLine[] {
  if (doc.rel === 'AGENTS.md') {
    const sec = section(doc.lines, 2, 'terms');
    return sec ? doc.lines.slice(sec.start + 1, sec.end) : [];
  }
  return /^skills\/[^/]+\/SKILL\.md$/.test(doc.rel) ? doc.lines : [];
}

function synonymFailures(doc: DocFile): Failure[] {
  const failures: Failure[] = [];
  for (const line of doc.lines) {
    if (line.fenced) continue;
    const text = withoutCodeSpans(line.text);
    for (const [word, term] of SYNONYMS) {
      if (new RegExp(`(?<![A-Za-z0-9_])${word}(?![A-Za-z0-9_])`, 'i').test(text)) {
        failures.push({ item: 'terms', where: at(doc.rel, line.n), reason: `"${word}" is a synonym; write "${term}"` });
      }
    }
  }
  return failures;
}

export function checkTerms(docs: readonly DocFile[]): Failure[] {
  const definitions = new Map<string, string[]>();
  for (const doc of docs) {
    for (const line of definitionLines(doc)) {
      if (line.fenced || isTableLine(line.text)) continue;
      const term = definedTerm(line.text);
      if (term === null) continue;
      definitions.set(term, [...(definitions.get(term) ?? []), at(doc.rel, line.n)]);
    }
  }
  const failures: Failure[] = [];
  for (const [term, wheres] of definitions) {
    if (wheres.length < 2) continue;
    for (const where of wheres) failures.push({ item: 'terms', where, reason: `"${term}" has ${String(wheres.length)} definition lines` });
  }
  for (const doc of docs) if (isHarnessDoc(doc.rel)) failures.push(...synonymFailures(doc));
  return failures;
}

// references

const AGENT_LINKS: readonly [string, string][] = [
  ['AGENTS.md', '../AGENTS.md'],
  ['harness settings', '../settings.json'],
  ['game settings schema', '../schemas/game-settings.schema.json'],
  ['harness settings schema', '../schemas/harness-settings.schema.json'],
];

function isExternal(target: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(target);
}

/** The file path of a link target: without `#anchor`, percent-decoded when the encoding is valid. */
function targetPath(target: string): string {
  const path = target.split('#')[0] as string;
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

function linkFailures(doc: DocFile): Failure[] {
  const failures: Failure[] = [];
  for (const line of doc.lines) {
    if (line.fenced) continue;
    for (const target of linkTargets(line.text)) {
      const path = targetPath(target);
      if (path === '' || isExternal(target)) continue;
      const info = statSync(join(dirname(doc.abs), path), { throwIfNoEntry: false });
      if (info === undefined) {
        failures.push({ item: 'references', where: at(doc.rel, line.n), reason: `link target ${target} does not exist` });
      } else if (!info.isFile()) {
        failures.push({ item: 'references', where: at(doc.rel, line.n), reason: `link target ${target} is not a file` });
      }
    }
  }
  return failures;
}

/** Each reference file of a skill (an `.md` file other than SKILL.md) is linked from that skill's SKILL.md. */
function depthFailures(harness: string, docs: readonly DocFile[]): Failure[] {
  const linked = new Map<string, Set<string>>();
  for (const doc of docs) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(doc.rel);
    if (!m) continue;
    const targets = doc.lines
      .filter((l) => !l.fenced)
      .flatMap((l) => linkTargets(l.text))
      .map((t) => normalize(relative(harness, join(dirname(doc.abs), targetPath(t)))).split('\\').join('/'));
    linked.set(m[1] as string, new Set(targets));
  }
  const failures: Failure[] = [];
  for (const doc of docs) {
    const m = /^skills\/([^/]+)\/(.+)$/.exec(doc.rel);
    if (!m || m[2] === 'SKILL.md') continue;
    if (linked.get(m[1] as string)?.has(doc.rel) !== true) {
      failures.push({ item: 'references', where: doc.rel, reason: `reference file is not linked from skills/${m[1] as string}/SKILL.md` });
    }
  }
  return failures;
}

function agentLinkFailures(doc: DocFile): Failure[] {
  const failures: Failure[] = [];
  for (const line of doc.lines) {
    if (line.fenced) continue;
    const targets = new Set(linkTargets(line.text));
    for (const [phrase, target] of AGENT_LINKS) {
      if (line.text.includes(phrase) && !targets.has(target)) {
        failures.push({ item: 'references', where: at(doc.rel, line.n), reason: `line names ${phrase} without a link to ${target}` });
      }
    }
  }
  return failures;
}

export function checkReferences(harness: string, docs: readonly DocFile[]): Failure[] {
  return [
    ...docs.flatMap(linkFailures),
    ...depthFailures(harness, docs),
    ...docs.filter((d) => /^agents\/[^/]+\.md$/.test(d.rel)).flatMap(agentLinkFailures),
  ];
}

// writing

/** `etc`, `etc.` or `and so on` as words, in any case. */
function hasEtc(text: string): boolean {
  return /(?<![A-Za-z])(?:etc|and so on)(?![A-Za-z])/i.test(text);
}

export const VAGUE_LIST_START = '- Do not use words that cannot be judged: ';

interface VagueList {
  words: string[];
  /** The list line in `AGENTS.md`, which the check does not read for the words. */
  n: number;
}

/** The word list of `AGENTS.md` `## harness writing rules`, or the failure when there is not exactly one list line. */
export function vagueWords(agents: DocFile | undefined): VagueList | Failure {
  const where = agents?.rel ?? 'AGENTS.md';
  const sec = agents ? section(agents.lines, 2, 'harness writing rules') : null;
  const lines = agents && sec ? agents.lines.slice(sec.start + 1, sec.end).filter((l) => !l.fenced && l.text.startsWith(VAGUE_LIST_START)) : [];
  const line = lines[0];
  if (lines.length !== 1 || line === undefined) {
    return { item: 'writing', where, reason: `## harness writing rules has ${String(lines.length)} lines starting with "${VAGUE_LIST_START}"; it must have one` };
  }
  return { words: line.text.slice(VAGUE_LIST_START.length).split(', ').map((w) => w.trim()).filter((w) => w !== ''), n: line.n };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first word or phrase of the list that the text uses as whole words, in any case, or null. */
export function vagueWord(text: string, words: readonly string[]): string | null {
  return words.find((word) => new RegExp(`(?<![A-Za-z])${escapeRegExp(word)}(?![A-Za-z])`, 'i').test(text)) ?? null;
}

export function checkWriting(docs: readonly DocFile[]): Failure[] {
  const agents = docs.find((d) => d.rel === 'AGENTS.md');
  const list = vagueWords(agents);
  const failures: Failure[] = 'item' in list ? [list] : [];
  const words = 'item' in list ? [] : list.words;
  for (const doc of docs) {
    for (const line of doc.lines) {
      if (line.fenced) continue;
      const text = withoutCodeSpans(line.text);
      if (hasEtc(text)) failures.push({ item: 'writing', where: at(doc.rel, line.n), reason: 'uses "etc." or "and so on"' });
      if (doc === agents && 'n' in list && line.n === list.n) continue;
      const word = vagueWord(text, words);
      if (word !== null) failures.push({ item: 'writing', where: at(doc.rel, line.n), reason: `uses "${word}", which cannot be judged` });
    }
  }
  return failures;
}

// English

const HANGUL = /[\u1100-\u11FF\u3130-\u318F\uAC00-\uD7A3]/;

/** Harness documents are English: Korean only inside code spans (Korean game text and localization syntax) and fences. */
export function checkEnglish(docs: readonly DocFile[]): Failure[] {
  const failures: Failure[] = [];
  for (const doc of docs) {
    if (!isHarnessDoc(doc.rel)) continue;
    for (const line of doc.lines) {
      if (!line.fenced && HANGUL.test(withoutCodeSpans(line.text))) failures.push({ item: 'English', where: at(doc.rel, line.n), reason: 'Korean outside code spans' });
    }
  }
  return failures;
}

// size

const SKILL_BODY_MAX = 500;
const TOC_MIN_LINES = 100;

function bodyLines(lines: readonly MdLine[]): number {
  if (lines[0]?.text !== '---') return lines.length;
  const close = lines.findIndex((l, i) => i > 0 && l.text === '---');
  return close < 0 ? lines.length : lines.length - close - 1;
}

/**
 * A table of contents: before the first `## ` heading, a run of bullet lines that lists the `##` and
 * `###` heading titles in file order and contains every `##` title.
 */
export function hasTableOfContents(lines: readonly MdLine[]): boolean {
  const headings = lines.filter((l) => headingLevel(l) === 2 || headingLevel(l) === 3);
  const titles = headings.map((l) => l.text.replace(/^#+ /, '').trim());
  const top = new Set(headings.filter((l) => headingLevel(l) === 2).map((l) => l.text.slice(3).trim()));
  const first = lines.findIndex((l) => headingLevel(l) === 2);
  if (top.size === 0) return false;
  const runs: string[][] = [[]];
  for (const line of lines.slice(0, first)) {
    if (!line.fenced && line.text.startsWith('- ')) (runs[runs.length - 1] as string[]).push(line.text.slice(2).trim());
    else runs.push([]);
  }
  return runs.some((run) => {
    let from = 0;
    for (const item of run) {
      const i = titles.indexOf(item, from);
      if (i < 0) return false;
      from = i + 1;
    }
    return [...top].every((t) => run.includes(t));
  });
}

export function checkSize(docs: readonly DocFile[]): Failure[] {
  const failures: Failure[] = [];
  for (const doc of docs) {
    const m = /^skills\/[^/]+\/(.+)$/.exec(doc.rel);
    if (!m) continue;
    if (m[1] === 'SKILL.md') {
      const body = bodyLines(doc.lines);
      if (body > SKILL_BODY_MAX) failures.push({ item: 'size', where: doc.rel, reason: `SKILL.md body has ${String(body)} lines (max ${String(SKILL_BODY_MAX)})` });
    } else if (doc.lines.length > TOC_MIN_LINES && !hasTableOfContents(doc.lines)) {
      failures.push({ item: 'size', where: doc.rel, reason: `reference file has ${String(doc.lines.length)} lines and no table of contents at the top` });
    }
  }
  return failures;
}
