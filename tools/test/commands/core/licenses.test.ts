import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { expressionIds, SPDX_EXCEPTIONS_DIR, spdxExceptionTexts, textIds } from '../../../src/commands/core/lib/spec-licenses.ts';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';

const spdx = createRequire(import.meta.url)('spdx-license-list/full') as Record<string, { licenseText: string }>;

const workspaces: TestWorkspace[] = [];
afterEach(() => {
  for (const ws of workspaces.splice(0)) rmSync(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

function workspace(manifest: unknown): TestWorkspace {
  const ws = makeWorkspace();
  workspaces.push(ws);
  writeFileSync(join(ws.coreImpl, 'licenses.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return ws;
}

const COMPONENTS = [
  { name: 'engine', version: '4.4', license: 'MIT', url: 'u', notice: '', platforms: ['web'], modules: [] },
  { name: 'sdk', version: '', license: '(Apache-2.0 OR MIT) AND BSD-3-Clause', url: 'u', notice: '', platforms: ['android'], modules: ['AdCore'] },
  { name: 'old', version: '', license: 'GPL-2.0+', url: 'u', notice: '', platforms: [], modules: [] },
];

describe('ogw core licenses', () => {
  it('writes the license texts of the components and of resource rights in byte order', async () => {
    const ws = workspace({ components: COMPONENTS, texts: { Stale: 'x' } });
    const run = await ogw(ws, ['core', 'licenses', '--json']);
    expect(run.code).toBe(0);
    const ids = ['Apache-2.0', 'BSD-3-Clause', 'CC-BY-4.0', 'CC0-1.0', 'GPL-2.0', 'MIT', 'OFL-1.1'];
    expect(JSON.parse(run.stdout)).toEqual({ path: join(ws.coreImpl, 'licenses.json'), written: true, ids });
    const written = readFileSync(join(ws.coreImpl, 'licenses.json'), 'utf8');
    const texts = Object.fromEntries(ids.map((id) => [id, spdx[id]?.licenseText]));
    expect(written).toBe(`${JSON.stringify({ components: COMPONENTS, texts }, null, 2)}\n`);
    const again = await ogw(ws, ['core', 'licenses']);
    expect(again.stdout).toBe(`unchanged ${join(ws.coreImpl, 'licenses.json')}: 7 license texts (${ids.join(', ')})\n`);
  });

  it('adds texts after components when the file has none', async () => {
    const ws = workspace({ components: [COMPONENTS[0]] });
    const run = await ogw(ws, ['core', 'licenses']);
    expect(run.stdout).toBe(`wrote ${join(ws.coreImpl, 'licenses.json')}: 4 license texts (CC-BY-4.0, CC0-1.0, MIT, OFL-1.1)\n`);
    expect(Object.keys(JSON.parse(readFileSync(join(ws.coreImpl, 'licenses.json'), 'utf8')) as object)).toEqual(['components', 'texts']);
  });

  it('does not write and names unknown IDs with their components', async () => {
    const components = [
      { name: 'a', license: 'MIT WITH Not-An-Exception' },
      { name: 'b', license: 'LicenseRef-x OR Not-An-Exception' },
      { name: 'c', license: 'Not-An-Exception' },
    ];
    const ws = workspace({ components });
    const before = statSync(join(ws.coreImpl, 'licenses.json')).mtimeMs;
    const run = await ogw(ws, ['core', 'licenses']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe('Not-An-Exception: not in the SPDX license list or exception list; used by a, b, c\n');
    expect(statSync(join(ws.coreImpl, 'licenses.json')).mtimeMs).toBe(before);
    const json = await ogw(ws, ['core', 'licenses', '--json']);
    expect(JSON.parse(json.stdout)).toEqual({ unknown: { 'Not-An-Exception': ['a', 'b', 'c'] } });
  });

  it('writes no text for a LicenseRef- or DocumentRef- license reference', async () => {
    const components = [
      { name: 'Google Mobile Ads SDK', license: 'LicenseRef-google-mobile-ads-sdk' },
      { name: 'Google UMP SDK', license: '(DocumentRef-ump:LicenseRef-ump AND Apache-2.0)' },
    ];
    const ws = workspace({ components });
    const run = await ogw(ws, ['core', 'licenses', '--json']);
    expect(run.code).toBe(0);
    const ids = ['Apache-2.0', 'CC-BY-4.0', 'CC0-1.0', 'OFL-1.1'];
    expect(JSON.parse(run.stdout)).toEqual({ path: join(ws.coreImpl, 'licenses.json'), written: true, ids });
    expect(Object.keys((JSON.parse(readFileSync(join(ws.coreImpl, 'licenses.json'), 'utf8')) as { texts: object }).texts)).toEqual(ids);
  });

  it('uses the core worktree the command runs in', async () => {
    const ws = workspace({ components: [] });
    const tree = join(ws.worktrees, '_core', 'w1');
    sh(ws.coreImpl, 'git', ['worktree', 'add', '--quiet', '-b', 'agent/w1', tree]);
    writeFileSync(join(tree, 'licenses.json'), '{"components": [{"name": "x", "license": "Zlib"}]}\n');
    expect((await ogw(ws, ['core', 'licenses'], { cwd: tree })).code).toBe(0);
    expect(Object.keys((JSON.parse(readFileSync(join(tree, 'licenses.json'), 'utf8')) as { texts: object }).texts)).toEqual(['CC-BY-4.0', 'CC0-1.0', 'OFL-1.1', 'Zlib']);
  });

  it('writes the text of an exception after WITH from the vendored SPDX exceptions', async () => {
    const ws = workspace({ components: [{ name: 'godot-cpp', license: 'GPL-2.0-only WITH Classpath-exception-2.0' }] });
    const run = await ogw(ws, ['core', 'licenses', '--json']);
    expect(run.code).toBe(0);
    const texts = (JSON.parse(readFileSync(join(ws.coreImpl, 'licenses.json'), 'utf8')) as { texts: Record<string, string> }).texts;
    expect(Object.keys(texts)).toEqual(['CC-BY-4.0', 'CC0-1.0', 'Classpath-exception-2.0', 'GPL-2.0-only', 'OFL-1.1']);
    const vendored = JSON.parse(readFileSync(join(SPDX_EXCEPTIONS_DIR, 'Classpath-exception-2.0.json'), 'utf8')) as { licenseExceptionText: string };
    expect(texts['Classpath-exception-2.0']).toBe(vendored.licenseExceptionText);
    expect(texts['Classpath-exception-2.0']).toMatch(/^Linking this library statically or dynamically/);
  });

  it('fails on a missing or malformed file and on arguments', async () => {
    const ws = workspace({ components: [{ name: 'x' }] });
    const path = join(ws.coreImpl, 'licenses.json');
    expect((await ogw(ws, ['core', 'licenses'])).stderr).toBe(`${path}: "components" must be a list of objects with string "name" and "license"\n`);
    writeFileSync(path, '[]');
    expect((await ogw(ws, ['core', 'licenses'])).code).toBe(1);
    writeFileSync(path, '{"components": [null]}');
    expect((await ogw(ws, ['core', 'licenses'])).code).toBe(1);
    expect((await ogw(ws, ['core', 'licenses', 'x'])).stderr).toBe('usage: ogw core licenses\n');
    rmSync(path);
    expect((await ogw(ws, ['core', 'licenses'])).stderr).toBe(`file not found: ${path}\n`);
  });
});

describe('spdxExceptionTexts', () => {
  it('reads the ID and text of every JSON file of the folder', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-spdx-'));
    try {
      writeFileSync(join(dir, 'b.json'), JSON.stringify({ licenseExceptionId: 'B-exception', licenseExceptionText: 'b text' }));
      writeFileSync(join(dir, 'a.json'), JSON.stringify({ licenseExceptionId: 'A-exception', licenseExceptionText: 'a text' }));
      writeFileSync(join(dir, 'notes.txt'), 'ignored');
      expect([...spdxExceptionTexts(dir)]).toEqual([['A-exception', 'a text'], ['B-exception', 'b text']]);
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'c.json'), JSON.stringify({ licenseExceptionId: 'C-exception' }));
      expect(() => spdxExceptionTexts(dir)).toThrow(`${join(dir, 'c.json')}: no licenseExceptionId or licenseExceptionText`);
      writeFileSync(join(dir, 'c.json'), JSON.stringify({ licenseExceptionText: 'c' }));
      expect(() => spdxExceptionTexts(dir)).toThrow('no licenseExceptionId or licenseExceptionText');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('has the vendored exceptions of the pinned tag', () => {
    expect(SPDX_EXCEPTIONS_DIR).toMatch(/vendor\/spdx-license-list-data\/v3\.27\.0\/json\/exceptions\/?$/);
    const texts = spdxExceptionTexts(SPDX_EXCEPTIONS_DIR);
    expect(texts.size).toBe(79);
    expect(texts.has('LLVM-exception')).toBe(true);
  });
});

describe('expressionIds', () => {
  it('reads license and exception IDs of an SPDX expression', () => {
    expect(expressionIds('(MIT OR Apache-2.0) AND GPL-2.0-or-later WITH Classpath-exception-2.0')).toEqual([
      'MIT',
      'Apache-2.0',
      'GPL-2.0-or-later',
      'Classpath-exception-2.0',
    ]);
    expect(expressionIds('mit and LGPL-2.1+ with x')).toEqual(['mit', 'LGPL-2.1', 'x']);
    expect(expressionIds('  ')).toEqual([]);
  });

  it('textIds drops license references', () => {
    expect(textIds('LicenseRef-a OR (MIT AND DocumentRef-d:LicenseRef-b) WITH LLVM-exception')).toEqual(['MIT', 'LLVM-exception']);
  });
});
