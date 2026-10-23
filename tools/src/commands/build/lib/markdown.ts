import { section } from '../../../lib/markdown.ts';

/** Lines of `section`, trimmed of blank lines at both ends; null when absent. */
export function sectionLines(text: string, heading: string): string[] | null {
  const body = section(text, heading);
  if (body === null) return null;
  while (body.length > 0 && (body[0] as string).trim() === '') body.shift();
  while (body.length > 0 && (body[body.length - 1] as string).trim() === '') body.pop();
  return body;
}

/** Section body as one string, `none` when it is absent or empty. */
export function sectionText(text: string, heading: string): string {
  const lines = sectionLines(text, heading);
  return lines && lines.length > 0 ? lines.join('\n') : 'none';
}

/**
 * Items of a markdown list or heading-separated document: a new item starts at a heading line
 * (`#` to `######`) or at a top-level `- ` / `* ` bullet. Lines before the first item are dropped.
 */
export function markdownItems(text: string): string[] {
  const items: string[][] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6} /.test(line) || /^[-*] /.test(line)) items.push([line]);
    else if (items.length > 0) (items[items.length - 1] as string[]).push(line);
  }
  return items.map((lines) => lines.join('\n').trimEnd()).filter((item) => item.length > 0);
}

/** Lines of a section that hold content; `none` alone counts as no content. */
export function contentItems(lines: readonly string[] | null): string[] {
  if (!lines) return [];
  const items = markdownItems(lines.join('\n'));
  if (items.length > 0) return items;
  const text = lines.join('\n').trim();
  return text === '' || text === 'none' ? [] : [text];
}

/** A markdown document from `## heading` and body pairs; an empty body is written `none`. */
export function renderSections(sections: readonly (readonly [string, string])[]): string {
  return sections.map(([heading, body]) => `## ${heading}\n\n${body.trim() === '' ? 'none' : body.trim()}\n`).join('\n');
}

/** `- a` lines, or `none` when empty. */
export function bullets(items: readonly string[]): string {
  return items.length === 0 ? 'none' : items.map((item) => `- ${item}`).join('\n');
}

/** An item without its leading `- ` or `* ` bullet. */
export function stripBullet(item: string): string {
  return item.replace(/^[-*] /, '');
}
