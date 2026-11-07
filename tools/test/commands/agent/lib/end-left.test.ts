// What an agent left when its CLI ended: a failure to end it fails the job, or is said beside the failure of the work.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { endWhatTheAgentLeft } from '../../../../src/commands/agent/lib/launch.ts';
import type { Context } from '../../../../src/lib/command.ts';

const ends = vi.hoisted(() => ({ calls: [] as string[], fail: new Set<string>() }));

function end(name: string): Promise<void> {
  ends.calls.push(name);
  return ends.fail.has(name) ? Promise.reject(new Error(`${name} failed`)) : Promise.resolve();
}

vi.mock('../../../../src/lib/jobs.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/lib/jobs.ts')>()),
  endJobsOfAgent: vi.fn(() => end('jobs')),
}));
vi.mock('../../../../src/commands/instance/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../src/commands/instance/api.ts')>()),
  stopInstancesOfAgent: vi.fn(() => end('instances').then(() => [])),
}));

function context(): Context & { lines: string[] } {
  const lines: string[] = [];
  return {
    env: {},
    lines,
    log: (line: string) => {
      lines.push(line);
    },
  } as unknown as Context & { lines: string[] };
}

const broker = { close: () => end('broker') };

beforeEach(() => {
  ends.calls = [];
  ends.fail = new Set();
});

describe('endWhatTheAgentLeft', () => {
  it('ends the jobs, the instances and the broker', async () => {
    const ctx = context();
    await endWhatTheAgentLeft(ctx, 'ag1', broker, false);
    expect(ends.calls).toEqual(['jobs', 'instances', 'broker']);
    expect(ctx.lines).toEqual([]);
  });

  it('after work that ended well, runs every end and fails with the first that failed', async () => {
    ends.fail = new Set(['jobs', 'broker']);
    const ctx = context();
    await expect(endWhatTheAgentLeft(ctx, 'ag1', broker, false)).rejects.toThrow('jobs failed');
    expect(ends.calls).toEqual(['jobs', 'instances', 'broker']);
  });

  it('after work that failed, keeps that failure and says each end that failed in the log', async () => {
    ends.fail = new Set(['instances']);
    const ctx = context();
    await expect(endWhatTheAgentLeft(ctx, 'ag1', null, true)).resolves.toBeUndefined();
    expect(ends.calls).toEqual(['jobs', 'instances']);
    expect(ctx.lines).toEqual(['agent ag1: instances failed']);
  });
});
