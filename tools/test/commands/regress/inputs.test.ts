import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CHECK_INPUT_EXCLUDED, CHECK_INPUT_PATHS, checkInputs } from '../../../src/commands/regress/lib/inputs.ts';
import { makeWorkspace, sh } from '../../helpers/workspace.ts';
import { ctxOf, write } from './helpers.ts';

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HARNESS = join(TOOLS, '..');

/** The code that `ogw regress check` runs: the checks, and what an instance start, the data tool run and the settings checks read. */
const CHECK_CODE = ['src/commands/check', 'src/commands/generate', 'src/commands/data', 'src/commands/instance', 'src/commands/settings', 'src/commands/code', 'src/lib'];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile() && e.name.endsWith('.ts'))
    .map((e) => join(e.parentPath, e.name));
}

/** The harness documents a source names: `'skills/...'` literals and `join(<root>, 'skills', '<name>', ...)` up to the first part that is no literal. */
function documentsNamed(text: string): string[] {
  const named = [...text.matchAll(/'((?:skills|agents)\/[^']+)'/g)].map((m) => m[1] as string);
  for (const m of text.matchAll(/join\((?:[^,()]|\([^()]*\))+((?:,\s*'[^']+')+)/g)) {
    const parts = [...(m[1] as string).matchAll(/'([^']+)'/g)].map((p) => p[1] as string);
    if (parts[0] === 'skills' || parts[0] === 'agents' || parts[0] === 'AGENTS.md') named.push(parts.join('/'));
  }
  return named;
}

describe('check inputs', () => {
  it('cover each harness document that the code of a check reads', () => {
    const named = CHECK_CODE.flatMap((dir) => sources(join(TOOLS, dir)).flatMap((file) => documentsNamed(readFileSync(file, 'utf8')).map((doc) => `${relative(TOOLS, file)}: ${doc}`)));
    // the scan finds the reads it is for
    const docs = new Set(named.map((line) => line.split(': ')[1]));
    for (const doc of ['skills/game-design/SKILL.md', 'skills/client-core/SKILL.md', 'skills/client-core/modules/qa-core.md', 'skills/build/engines']) expect(docs.has(doc), doc).toBe(true);
    const uncovered = named.filter((line) => {
      const doc = line.split(': ')[1] as string;
      return !CHECK_INPUT_PATHS.some((path) => (path.endsWith('/') ? `${doc}/`.startsWith(path) : doc === path));
    });
    expect(uncovered).toEqual([]);
    // each input is there, so that a rename does not drop it from the key
    for (const path of [...CHECK_INPUT_PATHS, ...CHECK_INPUT_EXCLUDED]) expect(existsSync(join(HARNESS, path)), path).toBe(true);
  });

  it('change with check code, settings, schemas and the documents checks read, and not with other documents or the tests', async () => {
    const ws = makeWorkspace();
    const ctx = ctxOf(ws);
    const files = ['tools/src/a.ts', 'tools/ogw.md', 'tools/test/a.test.ts', 'schemas/x.schema.json', 'settings.json', 'AGENTS.md', 'agents/content.md', 'skills/game-design/SKILL.md', 'skills/server-content/SKILL.md', 'skills/build/engines/godot.md'];
    for (const file of files) write(ws.harness, file, 'one\n');
    sh(ws.harness, 'git', ['add', '-A']);
    sh(ws.harness, 'git', ['commit', '-qm', 'one']);
    const key = async (): Promise<string> => checkInputs(ctx, ws.harness, sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim());
    let last = await key();
    const changed: Record<string, boolean> = {};
    for (const file of files) {
      write(ws.harness, file, `two ${file}\n`);
      sh(ws.harness, 'git', ['commit', '-qam', file]);
      const next = await key();
      changed[file] = next !== last;
      last = next;
    }
    expect(changed).toEqual({
      'tools/src/a.ts': true,
      'tools/ogw.md': false,
      'tools/test/a.test.ts': false,
      'schemas/x.schema.json': true,
      'settings.json': true,
      'AGENTS.md': false,
      'agents/content.md': false,
      'skills/game-design/SKILL.md': true,
      'skills/server-content/SKILL.md': false,
      'skills/build/engines/godot.md': true,
    });
  });
});
