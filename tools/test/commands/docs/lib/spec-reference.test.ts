import { describe, expect, it } from 'vitest';
import { mdLines } from '../../../../src/commands/core/lib/spec-md.ts';
import { readSpec } from '../../../../src/commands/core/lib/spec-parse.ts';
import type { SpecDoc } from '../../../../src/commands/docs/lib/spec-items.ts';
import {
  checkSpecReference,
  keyTest,
  localDataKeys,
  referenceOf,
  specMembers,
} from '../../../../src/commands/docs/lib/spec-reference.ts';
import { spec } from '../../core/lib/spec-fixture.ts';

const vocabulary = { dataTypes: new Set(['none']), purposes: new Set<string>() };

function specDoc(name: string, text: string): SpecDoc {
  const folder = 'skills/server-core/modules';
  const entry = { name, side: 'server' as const, spec: `/h/${folder}/${name}.md`, specRel: `${folder}/${name}.md` };
  const lines = mdLines(text);
  return { entry, lines, parsed: readSpec(entry, lines, vocabulary, new Set(['A', 'B'])) };
}

/** `<file>:<line>` of the first line of a spec that contains the text. */
function where(s: SpecDoc, text: string): string {
  const line = s.lines.find((l) => l.text.includes(text));
  if (!line) throw new Error(`no line with ${text}`);
  return `${s.entry.specRel}:${String(line.n)}`;
}

const B_API = [
  '| operation | input | output | failure value | caller |',
  '|---|---|---|---|---|',
  '| `op` | x | y | none | `A` |',
  '| plain | x | y | none | `A` |',
  '',
  '### component',
  '',
  '| component | operation | input | output | failure value | caller |',
  '|---|---|---|---|---|---|',
  '| `UIThing` | `comp_op` | x | y | none | content code |',
  '',
  '| type | contents |',
  '|---|---|',
  '| `NotAName` | x |',
].join('\n');
const B_DEV = '| operation | input | output | caller |\n|---|---|---|---|\n| `dev_op`(core cheat) | x | none | test |';
const B_EVENT = '| event | when | payload |\n|---|---|---|\n| `ThingEvent` | x | none |';
const B_HOOK = '| hook | when | input | output | default |\n|---|---|---|---|---|\n| `on_thing` | x | y | z | w |';
const B_SETTINGS = '| key | type | source | owner | meaning |\n|---|---|---|---|---|\n| `B.maxMs` | integer | core | content | m |';
const B_DATA = '| file kind | key | type | meaning |\n|---|---|---|---|\n| `device` | `B.saved` | `string` | m |\n| `device` | `B.seq_<env>` | `int64` | m |';

function moduleB(extra: Partial<Record<string, string>> = {}): SpecDoc {
  return specDoc('B', spec('B', { API: B_API, DEV: B_DEV, event: B_EVENT, hook: B_HOOK, settings: B_SETTINGS, data: B_DATA, ...extra }));
}

describe('spec members', () => {
  it('reads operations, component operations, DEV operations, events and hooks', () => {
    const members = specMembers(moduleB({ behavior: '| operation | x |\n|---|---|\n| `behavior_op` | y |' }).lines);
    expect([...members]).toEqual([
      ['op', 'operation'],
      ['comp_op', 'operation'],
      ['dev_op', 'operation'],
      ['ThingEvent', 'event'],
      ['on_thing', 'hook'],
    ]);
  });

  it('reads no names from a spec without the sections', () => {
    expect(specMembers(mdLines('# x\n')).size).toBe(0);
    expect(specMembers(mdLines('# x\n\n## hook\n\n| event | when |\n|---|---|\n| `E` | x |\n')).size).toBe(0);
  });

  it('reads the LocalDataCore keys of ## data', () => {
    expect(localDataKeys(moduleB().lines)).toEqual(['B.saved', 'B.seq_<env>']);
    expect(localDataKeys(mdLines('# x\n\n## data\n\n| file kind | type |\n|---|---|\n| `device` | `x` |\n'))).toEqual([]);
    expect(localDataKeys(mdLines('# x\n\n## data\n\n| file kind | key |\n|---|---|\n| `device` | plain |\n'))).toEqual([]);
  });
});

describe('keys and references', () => {
  it('matches keys exactly and <...> parts as one or more name characters', () => {
    const isKey = keyTest(['B.maxMs', 'B.seq_<env>', 'a.b']);
    expect(isKey('B.maxMs')).toBe(true);
    expect(isKey('B.seq_dev')).toBe(true);
    expect(isKey('B.seq_D_2')).toBe(true);
    expect(isKey('B.seq_')).toBe(false);
    expect(isKey('B.seq_dev.x')).toBe(false);
    expect(isKey('xB.seq_dev')).toBe(false);
    expect(isKey('B.seq-dev')).toBe(false);
    expect(isKey('B.maxMsX')).toBe(false);
    expect(isKey('aXb')).toBe(false);
    expect(keyTest(['a.<x>.b'])('aQ1.b')).toBe(false);
    expect(keyTest(['a.<x>.b'])('a.q.b')).toBe(true);
    expect(keyTest([])('a')).toBe(false);
  });

  it('reads <Module>.<name> of a module name that is not a key', () => {
    const modules = new Set(['B', 'item-ledger']);
    const isKey = keyTest(['B.maxMs']);
    expect(referenceOf('B.op', modules, isKey)).toEqual({ module: 'B', name: 'op' });
    expect(referenceOf('item-ledger.add_items', modules, isKey)).toEqual({ module: 'item-ledger', name: 'add_items' });
    expect(referenceOf('B._x9', modules, isKey)).toEqual({ module: 'B', name: '_x9' });
    expect(referenceOf('B.SearchUsers', modules, isKey)).toEqual({ module: 'B', name: 'SearchUsers' });
    expect(referenceOf('B.maxMs', modules, isKey)).toBeNull();
    expect(referenceOf('C.op', modules, isKey)).toBeNull();
    expect(referenceOf('B.op.x', modules, isKey)).toBeNull();
    expect(referenceOf('B.', modules, isKey)).toBeNull();
    expect(referenceOf('B.1x', modules, isKey)).toBeNull();
    expect(referenceOf('B.o-p', modules, isKey)).toBeNull();
    expect(referenceOf('x B.op', modules, isKey)).toBeNull();
    expect(referenceOf('B', modules, isKey)).toBeNull();
  });
});

describe('spec reference', () => {
  it('passes references to names, lifecycle operations and keys', () => {
    const a = specDoc('A', spec('A', {
      behavior: [
        '- `B.op`, `B.comp_op`, `B.dev_op`, `B.ThingEvent`, `B.on_thing`, `B.init`, `B.release`',
        '- `B.maxMs`, `B.saved`, `B.seq_dev`, `C.op`, `B.op.x`, `A.init`',
        "- `B` 's `op`, `B`'s `nope`, `C`'s `op`, `A`'s `a_op`, `B`'s plain, `nope` of `B`, `a_op` of `A`",
      ].join('\n'),
      API: '| operation | input | output | failure value | caller |\n|---|---|---|---|---|\n| `a_op` | x | y | none | z |',
    }));
    expect(checkSpecReference([a, moduleB()])).toEqual([]);
  });

  it('fails references to missing names in any module, outside code fences', () => {
    const a = specDoc('A', spec('A', {
      behavior: '- `B.nope` and `B.plain` and `B.NotAName`\n```\n`B.fenced`\n```\n- `A.missing`',
    }));
    const failures = checkSpecReference([a, moduleB()]);
    expect(failures).toEqual([
      { item: 'spec reference', where: where(a, 'B.nope'), reason: '`B.nope`: B has no operation, event or hook `nope`' },
      { item: 'spec reference', where: where(a, 'B.nope'), reason: '`B.plain`: B has no operation, event or hook `plain`' },
      { item: 'spec reference', where: where(a, 'B.nope'), reason: '`B.NotAName`: B has no operation, event or hook `NotAName`' },
      { item: 'spec reference', where: where(a, 'A.missing'), reason: '`A.missing`: A has no operation, event or hook `missing`' },
    ]);
  });

  it("fails `<Module>`'s `<name>` and `<name>` of `<Module>` for a name of another module", () => {
    const a = specDoc('A', spec('A', {
      behavior: "- call `B`'s `op` and `ThingEvent` of `B`\n- `a_op` of `A` and `A`'s `a_op`, `B`'s plain, `op` of the `B`",
      API: '| operation | input | output | failure value | caller |\n|---|---|---|---|---|\n| `a_op` | x | y | none | z |',
    }));
    expect(checkSpecReference([a, moduleB()])).toEqual([
      { item: 'spec reference', where: where(a, "call `B`'s"), reason: 'write `B.op` for the operation of another module' },
      { item: 'spec reference', where: where(a, "call `B`'s"), reason: 'write `B.ThingEvent` for the event of another module' },
    ]);
  });

  it("fails `<Module>`'s `<name>` for each kind of member of another module", () => {
    const a = specDoc('A', spec('A', { behavior: "- call `B`'s `op`, then `B`'s `ThingEvent` and `B`'s `on_thing`\n- x `B`'s `dev_op`" }));
    expect(checkSpecReference([a, moduleB()])).toEqual([
      { item: 'spec reference', where: where(a, "call `B`'s"), reason: 'write `B.op` for the operation of another module' },
      { item: 'spec reference', where: where(a, "call `B`'s"), reason: 'write `B.ThingEvent` for the event of another module' },
      { item: 'spec reference', where: where(a, "call `B`'s"), reason: 'write `B.on_thing` for the hook of another module' },
      { item: 'spec reference', where: where(a, 'dev_op'), reason: 'write `B.dev_op` for the operation of another module' },
    ]);
  });

  it('fails a table whose header is in two specs', () => {
    const table = '`data/tables/t.csv`\n\n| column | type | build target |\n|---|---|---|\n| `id` | `id` | `All` |';
    const a = specDoc('A', spec('A', { data: table }));
    const b = specDoc('B', spec('B', { data: `${table}\n\n\`data/tables/u.csv\`\n\n| column | type | build target |\n|---|---|---|` }));
    expect(checkSpecReference([a, b])).toEqual([
      { item: 'spec reference', where: 'skills/server-core/modules/A.md:37', reason: 'table header of `t` is written in 2 specs' },
      { item: 'spec reference', where: 'skills/server-core/modules/B.md:37', reason: 'table header of `t` is written in 2 specs' },
    ]);
  });
});
