import { OgwError } from '../../../lib/errors.ts';

/** One `key=value` of a Godot config file (`project.godot` syntax). `value` is the raw text. */
export interface CfgEntry {
  section: string;
  key: string;
  value: string;
  /** 1-based line of the key. */
  line: number;
}

/** Full setting name: `<section>/<key>`, or the key alone outside a section. */
export function settingName(entry: CfgEntry): string {
  return entry.section === '' ? entry.key : `${entry.section}/${entry.key}`;
}

interface Scan {
  depth: number;
  inString: boolean;
  escaped: boolean;
}

function scanChar(state: Scan, ch: string): void {
  if (state.inString) {
    if (state.escaped) state.escaped = false;
    else if (ch === '\\') state.escaped = true;
    else if (ch === '"') state.inString = false;
    return;
  }
  if (ch === '"') state.inString = true;
  else if ('{[('.includes(ch)) state.depth++;
  else if ('}])'.includes(ch)) state.depth--;
}

function isOpen(state: Scan): boolean {
  return state.inString || state.depth > 0;
}

/** Parses a Godot config file. Values may span lines until brackets and strings close. */
export function parseCfg(text: string, file: string): CfgEntry[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const entries: CfgEntry[] = [];
  let section = '';
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line === '' || line.startsWith(';') || line.startsWith('#')) continue;
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      section = (header[1] as string).trim();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) throw new OgwError(`${file}:${String(i + 1)}: not a key=value line`);
    const start = i;
    const state: Scan = { depth: 0, inString: false, escaped: false };
    let value = line.slice(eq + 1).trim();
    for (const ch of value) scanChar(state, ch);
    while (isOpen(state) && i + 1 < lines.length) {
      i++;
      const more = lines[i] as string;
      value += `\n${more}`;
      for (const ch of `\n${more}`) scanChar(state, ch);
    }
    if (isOpen(state)) throw new OgwError(`${file}:${String(start + 1)}: value is not closed`);
    entries.push({ section, key: line.slice(0, eq).trim(), value, line: start + 1 });
  }
  return entries;
}

/** One `Object(<class>, ...)` of an input action value. */
export interface InputEventText {
  className: string;
  text: string;
}

/** The `Object(...)` items of an input action value, in order. */
export function inputEvents(value: string): InputEventText[] {
  const result: InputEventText[] = [];
  let from = value.indexOf('Object(');
  while (from !== -1) {
    const state: Scan = { depth: 0, inString: false, escaped: false };
    let end = from + 'Object'.length;
    for (; end < value.length; end++) {
      scanChar(state, value[end] as string);
      if (!isOpen(state)) break;
    }
    const text = value.slice(from, end + 1);
    result.push({ className: /^Object\(\s*([A-Za-z0-9_]+)/.exec(text)?.[1] ?? '', text });
    from = value.indexOf('Object(', end + 1);
  }
  return result;
}

export function intProperty(eventText: string, name: string): number {
  const match = new RegExp(`"${name}"\\s*:\\s*(-?\\d+)`).exec(eventText);
  return match ? Number(match[1]) : 0;
}

export function numberProperty(eventText: string, name: string): number {
  const match = new RegExp(`"${name}"\\s*:\\s*(-?\\d+(?:\\.\\d+)?(?:e[-+]?\\d+)?)`).exec(eventText);
  return match ? Number(match[1]) : 0;
}

/** Quotes a string as a Godot config value. */
export function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`;
}
