import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('tools/bin/ogw', () => {
  it('runs ogw and the processes it starts with IPv4 first, over a DNS order the given NODE_OPTIONS set', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-launcher-'));
    const seen = join(dir, 'seen');
    // a preload that records what node got and ends before ogw runs
    const preload = join(dir, 'record.cjs');
    writeFileSync(preload, `require('node:fs').writeFileSync(${JSON.stringify(seen)}, JSON.stringify([process.env.NODE_OPTIONS, require('node:dns').getDefaultResultOrder()])); process.exit(0);\n`);
    const launcher = join(import.meta.dirname, '..', '..', 'bin', 'ogw');
    const given = `--require ${preload} --dns-result-order=verbatim`;
    const result = spawnSync(launcher, ['--help'], { env: { ...process.env, NODE_OPTIONS: given }, encoding: 'utf8' });
    expect(result.status).toBe(0);
    // children get the same NODE_OPTIONS
    expect(JSON.parse(readFileSync(seen, 'utf8'))).toEqual([`${given} --dns-result-order=ipv4first`, 'ipv4first']);
  });
});
