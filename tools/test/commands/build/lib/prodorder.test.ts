import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readProdOrders } from '../../../../src/commands/build/lib/prodorder.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';

describe('readProdOrders', () => {
  it('reads the English deploy, rollback and maintenance orders', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.harness, 'skills', 'build'), { recursive: true });
    writeFileSync(join(ws.harness, 'skills', 'build', 'SKILL.md'), [
      '## deploy',
      '',
      'A human deploys PROD. The report carries the order below.',
      '',
      '1. first',
      '2. second',
      '',
      'The report also carries the rollback order below.',
      '',
      '1. back',
      '',
      'The report also carries the maintenance order: switch, then wait',
      '',
    ].join('\n'));
    expect(await readProdOrders(ws.env)).toEqual({ deploy: ['first', 'second'], rollback: ['back'], maintenance: 'switch, then wait' });
  });
});
