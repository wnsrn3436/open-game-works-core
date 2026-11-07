import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listDocs } from '../../../../src/commands/docs/lib/files.ts';

function harness(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ogw-docs-files-'));
  execFileSync('git', ['init', '-q', dir]);
  mkdirSync(join(dir, 'skills', 'a'), { recursive: true });
  writeFileSync(join(dir, 'AGENTS.md'), '# a\n');
  writeFileSync(join(dir, 'skills', 'a', 'SKILL.md'), '# s\n');
  execFileSync('git', ['-C', dir, 'add', '.']);
  return dir;
}

describe('listDocs', () => {
  it('leaves out a tracked document deleted from the working tree', async () => {
    const dir = harness();
    rmSync(join(dir, 'skills', 'a', 'SKILL.md'));
    expect((await listDocs(dir)).map((d) => d.rel)).toEqual(['AGENTS.md']);
  });

  it('fails when a tracked document cannot be looked at', async () => {
    const dir = harness();
    // the folder of a tracked document is now a file: its path is not a missing file but cannot be read
    rmSync(join(dir, 'skills', 'a'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'a'), 'a file');
    await expect(listDocs(dir)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
