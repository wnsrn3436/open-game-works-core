import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliStates, type CliDef } from '../../../src/commands/env/lib/hostcheck.ts';

describe('cliStates', () => {
  it('checks each CLI once for every agent group and provider method that uses it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-cli-states-'));
    const bin = join(root, 'bin');
    mkdirSync(bin);
    const log = join(root, 'calls.log');
    writeFileSync(log, '');
    writeFileSync(join(bin, 'fakecli'), `#!/bin/sh\necho "$*" >> ${log}\nexit 0\n`);
    chmodSync(join(bin, 'fakecli'), 0o755);
    const def: CliDef = { program: 'fakecli', login: ['login', 'status'] };
    const states = cliStates({ ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` });
    const [a, b] = await Promise.all([states(def), states(def)]);
    expect(a).toEqual(b);
    expect(a.installed).toBe(true);
    expect(readFileSync(log, 'utf8').split('\n').filter((line) => line !== '').length).toBeLessThanOrEqual(1);
  });
});
