/** Godot text scene (`.tscn`) and text resource (`.tres`) reader. */

export type Variant =
  | { t: 'str'; v: string }
  | { t: 'sname'; v: string }
  | { t: 'num'; v: number; text: string }
  | { t: 'bool'; v: boolean }
  | { t: 'null' }
  | { t: 'call'; name: string; args: Variant[] }
  | { t: 'arr'; items: Variant[] }
  | { t: 'dict'; entries: { key: Variant; value: Variant }[] }
  | { t: 'raw'; text: string };

export interface Prop {
  value: Variant;
  line: number;
}

export interface Section {
  tag: string;
  attrs: Record<string, Variant>;
  props: Map<string, Prop>;
  line: number;
}

export interface ExtResource {
  id: string;
  type: string;
  path: string;
  line: number;
}

export interface SceneNode {
  name: string;
  type: string | null;
  /** Node path in the scene: `.` for the root, `A/B` below it. */
  path: string;
  parent: string | null;
  /** ext_resource id of the instanced scene. */
  instance: string | null;
  props: Map<string, Prop>;
  line: number;
}

export interface TextScene {
  path: string;
  header: Section | null;
  sections: Section[];
  ext: Map<string, ExtResource>;
  sub: Map<string, Section>;
  nodes: SceneNode[];
}

class ValueReader {
  private readonly src: string;
  pos: number;
  line: number;

  constructor(src: string, pos: number, line: number) {
    this.src = src;
    this.pos = pos;
    this.line = line;
  }

  private ws(stopAtNewline: boolean): void {
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos];
      if (ch === '\n') {
        if (stopAtNewline) return;
        this.line++;
      } else if (ch !== ' ' && ch !== '\t' && ch !== '\r') {
        return;
      }
      this.pos++;
    }
  }

  value(): Variant {
    this.ws(false);
    const ch = this.src[this.pos] ?? '';
    if (ch === '"') return { t: 'str', v: this.string() };
    if (ch === '&' && this.src[this.pos + 1] === '"') {
      this.pos++;
      return { t: 'sname', v: this.string() };
    }
    if (ch === '^' && this.src[this.pos + 1] === '"') {
      this.pos++;
      return { t: 'call', name: 'NodePath', args: [{ t: 'str', v: this.string() }] };
    }
    if (ch === '[') return { t: 'arr', items: this.list(']') };
    if (ch === '{') return this.dict();
    const num = /^[-+]?(?:[0-9]+\.?[0-9]*(?:e[-+]?[0-9]+)?|inf|nan)/i.exec(this.src.slice(this.pos));
    if (num && /[-+0-9]/.test(ch)) {
      this.pos += num[0].length;
      return { t: 'num', v: Number(num[0]), text: num[0] };
    }
    return this.word();
  }

  private word(): Variant {
    const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?/.exec(this.src.slice(this.pos));
    if (!m) {
      const start = this.pos;
      while (this.pos < this.src.length && !/[\s,\]})]/.test(this.src[this.pos] as string)) this.pos++;
      if (this.pos === start) this.pos++;
      return { t: 'raw', text: this.src.slice(start, this.pos) };
    }
    this.pos += m[0].length;
    const name = m[0];
    if (name === 'true' || name === 'false') return { t: 'bool', v: name === 'true' };
    if (name === 'null') return { t: 'null' };
    this.ws(false);
    if (this.src[this.pos] === '(') return { t: 'call', name, args: this.list(')') };
    return { t: 'raw', text: name };
  }

  private string(): string {
    let out = '';
    this.pos++;
    while (this.pos < this.src.length) {
      const ch = this.src[this.pos] as string;
      if (ch === '\\') {
        const esc = this.src[this.pos + 1] ?? '';
        out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc;
        this.pos += 2;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        return out;
      }
      if (ch === '\n') this.line++;
      out += ch;
      this.pos++;
    }
    return out;
  }

  private list(close: string): Variant[] {
    this.pos++;
    const items: Variant[] = [];
    for (;;) {
      this.ws(false);
      if (this.pos >= this.src.length) return items;
      if (this.src[this.pos] === close) {
        this.pos++;
        return items;
      }
      const before = this.pos;
      items.push(this.value());
      this.ws(false);
      if (this.src[this.pos] === ',') this.pos++;
      if (this.pos === before) this.pos++;
    }
  }

  private dict(): Variant {
    this.pos++;
    const entries: { key: Variant; value: Variant }[] = [];
    for (;;) {
      this.ws(false);
      if (this.pos >= this.src.length) break;
      if (this.src[this.pos] === '}') {
        this.pos++;
        break;
      }
      const before = this.pos;
      const key = this.value();
      this.ws(false);
      if (this.src[this.pos] === ':') this.pos++;
      const value = this.value();
      entries.push({ key, value });
      this.ws(false);
      if (this.src[this.pos] === ',') this.pos++;
      if (this.pos === before) this.pos++;
    }
    return { t: 'dict', entries };
  }

  /** Reads `key=value` attributes of a section header up to `]`. */
  attrs(): Record<string, Variant> {
    const out: Record<string, Variant> = {};
    for (;;) {
      this.ws(true);
      const m = /^([A-Za-z_][A-Za-z0-9_/]*)=/.exec(this.src.slice(this.pos));
      if (!m) break;
      this.pos += m[0].length;
      out[m[1] as string] = this.value();
    }
    const close = this.src.indexOf(']', this.pos);
    const eol = this.src.indexOf('\n', this.pos);
    this.pos = close !== -1 && (eol === -1 || close < eol) ? close + 1 : eol === -1 ? this.src.length : eol;
    return out;
  }
}

export function strOf(v: Variant | undefined): string | null {
  if (!v) return null;
  if (v.t === 'str' || v.t === 'sname') return v.v;
  return null;
}

/** The ext_resource id of `ExtResource("id")`, or null. */
export function extIdOf(v: Variant | undefined): string | null {
  if (v?.t !== 'call' || v.name !== 'ExtResource') return null;
  return strOf(v.args[0]);
}

function nodePath(name: string, parent: string | null): string {
  if (parent === null) return '.';
  if (parent === '.') return name;
  return `${parent}/${name}`;
}

function sectionTo(scene: TextScene, section: Section): void {
  if (section.tag === 'gd_scene' || section.tag === 'gd_resource') {
    scene.header = section;
  } else if (section.tag === 'ext_resource') {
    const id = strOf(section.attrs.id) ?? (section.attrs.id?.t === 'num' ? section.attrs.id.text : null);
    if (id !== null) {
      scene.ext.set(id, { id, type: strOf(section.attrs.type) ?? '', path: strOf(section.attrs.path) ?? '', line: section.line });
    }
  } else if (section.tag === 'sub_resource') {
    const id = strOf(section.attrs.id);
    if (id !== null) scene.sub.set(id, section);
  } else if (section.tag === 'node') {
    const name = strOf(section.attrs.name) ?? '';
    const parent = strOf(section.attrs.parent);
    scene.nodes.push({
      name,
      type: strOf(section.attrs.type),
      parent,
      path: nodePath(name, parent),
      instance: extIdOf(section.attrs.instance),
      props: section.props,
      line: section.line,
    });
  }
}

/** Parses a `.tscn` or `.tres` file. Unknown text is skipped. */
export function parseTextScene(path: string, text: string): TextScene {
  const scene: TextScene = { path, header: null, sections: [], ext: new Map(), sub: new Map(), nodes: [] };
  let pos = 0;
  let line = 1;
  let current: Section | null = null;
  while (pos < text.length) {
    const eol = text.indexOf('\n', pos);
    const lineText = text.slice(pos, eol === -1 ? text.length : eol);
    const header = /^\[([A-Za-z_]+)/.exec(lineText);
    const prop = /^([A-Za-z_][A-Za-z0-9_/:.]*)\s*=\s*/.exec(lineText);
    let lineAtPos = line;
    if (header) {
      const reader = new ValueReader(text, pos + header[0].length, line);
      current = { tag: header[1] as string, attrs: reader.attrs(), props: new Map(), line };
      scene.sections.push(current);
      sectionTo(scene, current);
      lineAtPos = reader.line;
      pos = reader.pos;
    } else if (prop && current) {
      const reader = new ValueReader(text, pos + prop[0].length, line);
      current.props.set(prop[1] as string, { value: reader.value(), line });
      lineAtPos = reader.line;
      pos = reader.pos;
    }
    const nl = text.indexOf('\n', pos);
    if (nl === -1) break;
    line = lineAtPos + 1;
    pos = nl + 1;
  }
  return scene;
}

/** The script path of a node (`script = ExtResource(...)`), or null. */
export function nodeScript(scene: TextScene, node: SceneNode): string | null {
  const id = extIdOf(node.props.get('script')?.value);
  if (id === null) return null;
  return scene.ext.get(id)?.path ?? null;
}

/** The instanced scene path of a node, or null. */
export function nodeInstance(scene: TextScene, node: SceneNode): string | null {
  if (node.instance === null) return null;
  return scene.ext.get(node.instance)?.path ?? null;
}
