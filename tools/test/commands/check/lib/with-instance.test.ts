import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Slots, withInstance } from '../../../../src/commands/check/lib/instances.ts';
import { listInstances, startInstance, stopInstance, type InstanceInfo, type StartHooks } from '../../../../src/commands/instance/api.ts';
import { createContext, type Context } from '../../../../src/lib/command.ts';

vi.mock('../../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(), listInstances: vi.fn() }));

let base: string;
let ctx: Context;
const order: string[] = [];

/** An instance `i1` whose folder has `main.log`; `exited` is what `listInstances` reports for it. */
function instance(exited: Record<string, number | null>): InstanceInfo {
  const info = { id: 'i1', game: 'g', exited: {} } as InstanceInfo;
  vi.mocked(listInstances).mockResolvedValue([{ ...info, exited }]);
  return info;
}

function kept(): boolean {
  return existsSync(join(base, 'evidence', 'instance-i1', 'main.log'));
}

beforeEach(() => {
  vi.mocked(startInstance).mockReset();
  vi.mocked(stopInstance).mockReset();
  vi.mocked(listInstances).mockReset();
  order.length = 0;
  base = mkdtempSync(join(tmpdir(), 'ogw-with-instance-'));
  const instances = join(base, 'instances');
  mkdirSync(join(instances, 'i1'), { recursive: true });
  writeFileSync(join(instances, 'i1', 'main.log'), 'client\n');
  writeFileSync(join(instances, 'i1.json'), JSON.stringify({ id: 'i1', startedAt: 0, pids: {} }));
  ctx = createContext({ cwd: base, env: { ...process.env, OGW_INSTANCES_DIR: instances }, stdin: () => Promise.resolve(''), stderr: () => undefined });
  vi.mocked(stopInstance).mockImplementation(() => {
    order.push(kept() ? 'stop after keep' : 'stop');
    return Promise.resolve();
  });
});

const evidence = (): { root: string; dir: string; relative: boolean } => ({ root: base, dir: 'evidence', relative: true });

describe('withInstance', () => {
  it('keeps the instance logs before the stop when a client process ended', async () => {
    vi.mocked(startInstance).mockResolvedValue(instance({ main: null }));
    expect(await withInstance(ctx, new Slots(1), { game: 'g' }, () => Promise.resolve('done'), evidence())).toBe('done');
    expect(order).toEqual(['stop after keep']);
  });

  it('keeps the instance logs when the work throws', async () => {
    vi.mocked(startInstance).mockResolvedValue(instance({}));
    await expect(withInstance(ctx, new Slots(1), { game: 'g' }, () => Promise.reject(new Error('broke')), evidence())).rejects.toThrow('broke');
    expect(order).toEqual(['stop after keep']);
  });

  it('keeps the instance logs when the start fails, before startInstance stops it', async () => {
    vi.mocked(startInstance).mockImplementation(async (_ctx, _options, hooks?: StartHooks) => {
      await hooks?.beforeFailedStop?.('i1');
      order.push(kept() ? 'failed after keep' : 'failed');
      throw new Error('main: the client process ended with 6');
    });
    await expect(withInstance(ctx, new Slots(1), { game: 'g' }, () => Promise.resolve('x'), evidence())).rejects.toThrow('ended with 6');
    expect(order).toEqual(['failed after keep']);
  });

  it('keeps nothing when the work passes and only the server ended, or without evidence', async () => {
    vi.mocked(startInstance).mockResolvedValue(instance({ server: 0 }));
    await withInstance(ctx, new Slots(1), { game: 'g' }, () => Promise.resolve('done'), evidence());
    vi.mocked(startInstance).mockResolvedValue(instance({ main: null }));
    await withInstance(ctx, new Slots(1), { game: 'g' }, () => Promise.resolve('done'));
    expect(order).toEqual(['stop', 'stop']);
    expect(kept()).toBe(false);
  });
});
