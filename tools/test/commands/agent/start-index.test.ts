// A play or judge agent is in the index of running agents from the start of its job, before its agent CLI starts.
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { writeJsonAtomic } from '../../../src/lib/fsx.ts';
import { newId } from '../../../src/lib/ids.ts';
import type * as Jobs from '../../../src/lib/jobs.ts';
import { pidNamespace } from '../../../src/lib/proc.ts';
import { ogw, makeWorkspace } from '../../helpers/workspace.ts';
import { gameWithRun } from './helpers.ts';

// the job record is written as `startJob` writes it, but no supervisor runs it: the agent CLI never starts
vi.mock('../../../src/lib/jobs.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Jobs>();
  return {
    ...real,
    async startJob(options: Jobs.StartJobOptions): Promise<string> {
      const id = options.id ?? newId();
      const record: Jobs.JobRecord = {
        id,
        argv: options.argv,
        cwd: options.cwd,
        command: options.command,
        game: options.game,
        startedAt: Date.now(),
        endedAt: null,
        status: 'running',
        exitCode: null,
        supervisorPid: process.pid,
        bootId: real.hostBootId(),
        pidNs: pidNamespace(),
        pid: null,
        timeLimitMs: options.timeLimitMs,
        agentJob: options.agentJob,
        summary: null,
        meta: options.meta ?? {},
      };
      await writeJsonAtomic((await real.jobPaths(id, options.env)).record, record);
      return id;
    },
  };
});

describe('ogw agent: play and judge start', () => {
  it.each(['play', 'judge'])('makes ogw command refuse the instances of a %s agent whose CLI has not started', async (role) => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const input = join(ws.root, 'input.json');
    const playGuide = join(root, 'play-guide.md');
    const judgeInput = { A: { instance: 'inst1', playGuide, moment: null }, B: null, fixtures: [] };
    writeFileSync(input, JSON.stringify(role === 'play' ? { instance: 'inst1', playGuide, moment: null } : judgeInput));
    const started = await ogw(ws, ['agent', role, '--game', 'g', '--input', input, '--background'], { cwd: root });
    expect(started).toMatchObject({ code: 0 });
    const id = started.stdout.trim();
    const { readJob } = await vi.importActual<typeof Jobs>('../../../src/lib/jobs.ts');
    const meta = (await readJob(id, ws.env)).meta;
    try {
      expect(meta.instances).toEqual(['inst1']);
      const run = await ogw(ws, ['command', 'inst1', 'get_state']);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toContain(`instance inst1 is played by the running ${role} agent ${id}`);
    } finally {
      rmSync(meta.folder as string, { recursive: true, force: true });
    }
  });
});
