/**
 * Changed kinds of the save schema check (`build` `### save schema check`): game contract UserState, server state and
 * game state kinds whose definition, or the definition of a game contract message or enum they reach, differs
 * (comments left out) from the last PROD build.
 */
import { tokenize } from '../../core/lib/proto.ts';

/** The storage table of each kind file and the name suffix of its kinds (`contract` `## UserState`). */
export const KIND_FILES = [
  { file: 'user_state.proto', table: 'user_state', suffix: 'UserState' },
  { file: 'server_state.proto', table: 'server_state', suffix: 'ServerState' },
  { file: 'game_state.proto', table: 'game_state', suffix: 'GameState' },
] as const;

export interface Kind {
  name: string;
  table: (typeof KIND_FILES)[number]['table'];
}

/** A contract: top-level message and enum definitions (tokens without comments) and its kinds. */
export interface ContractDefs {
  defs: Map<string, string[]>;
  kinds: Kind[];
}

function blockEnd(tokens: readonly string[], open: number): number {
  let depth = 0;
  for (let i = open; i < tokens.length; i++) {
    if (tokens[i] === '{') depth += 1;
    if (tokens[i] === '}') depth -= 1;
    if (depth === 0) return i;
  }
  return tokens.length - 1;
}

/** Top-level `message` and `enum` blocks of one proto file, by name. */
export function topLevelDefs(text: string): Map<string, string[]> {
  const tokens = tokenize(text).filter((t) => t.kind !== 'comment').map((t) => t.text);
  const defs = new Map<string, string[]>();
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    const name = tokens[i + 1];
    if ((word === 'message' || word === 'enum') && name !== undefined && tokens[i + 2] === '{') {
      const end = blockEnd(tokens, i + 2);
      defs.set(name, tokens.slice(i, end + 1));
      i = end;
    } else if (tokens[i] === '{') {
      i = blockEnd(tokens, i);
    }
  }
  return defs;
}

/** The definitions and kinds of the game contract files (file name to text). */
export function contractDefs(files: ReadonlyMap<string, string>): ContractDefs {
  const defs = new Map<string, string[]>();
  const kinds: Kind[] = [];
  for (const [file, text] of files) {
    const fileDefs = topLevelDefs(text);
    for (const [name, tokens] of fileDefs) defs.set(name, tokens);
    const kindFile = KIND_FILES.find((k) => k.file === file);
    if (kindFile === undefined) continue;
    for (const [name, tokens] of fileDefs) {
      if (tokens[0] === 'message' && name.endsWith(kindFile.suffix)) kinds.push({ name, table: kindFile.table });
    }
  }
  return { defs, kinds };
}

/** The names of the definitions `name` reaches, itself included, in reach order. */
export function reach(defs: ReadonlyMap<string, readonly string[]>, name: string): string[] {
  const seen: string[] = [];
  const queue = [name];
  while (queue.length > 0) {
    const next = queue.shift() as string;
    if (seen.includes(next) || !defs.has(next)) continue;
    seen.push(next);
    for (const token of defs.get(next) ?? []) {
      const base = token.split('.').at(-1) ?? token;
      for (const candidate of [token, base]) if (defs.has(candidate) && !seen.includes(candidate)) queue.push(candidate);
    }
  }
  return seen;
}

function sameDefs(now: ContractDefs, prod: ContractDefs, kind: string): boolean {
  const a = reach(now.defs, kind);
  const b = reach(prod.defs, kind);
  if (a.join(' ') !== b.join(' ')) return false;
  return a.every((name) => (now.defs.get(name) ?? []).join(' ') === (prod.defs.get(name) ?? []).join(' '));
}

/** Kinds of the current contract that the last PROD build also has and whose reached definitions differ. */
export function changedKinds(now: ContractDefs, prod: ContractDefs): Kind[] {
  return now.kinds.filter((kind) => prod.kinds.some((p) => p.name === kind.name && p.table === kind.table) && !sameDefs(now, prod, kind.name));
}

/** The storage `kind` column value of a kind: the snake_case of its name. */
export function kindColumn(name: string): string {
  return name.replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2').replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
}
