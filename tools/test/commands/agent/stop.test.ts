import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { listRecords, writeRecord, type InstanceRecord } from '../../../src/commands/instance/lib/records.ts';
import { jobsDir, readJob } from '../../../src/lib/jobs.ts';
import { ogw, makeWorkspace } from '../../helpers/workspace.ts';

/** A running job record with no process, so ending it signals nothing. */
async function jobRecord(env: NodeJS.ProcessEnv, id: string, command: string, meta: Record<string, unknown> = {}): Promise<void> {
  const dir = await jobsDir(env);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, `${id}.json`),
    JSON.stringify({ id, argv: [command], cwd: '/', command, game: 'g', startedAt: Date.now(), endedAt: null, status: 'running', exitCode: null, supervisorPid: null, pid: null, timeLimitMs: 60_000, agentJob: null, summary: null, meta }),
  );
}

function instance(id: string, agentJob: string | null): InstanceRecord {
  return { id, game: 'g', root: '/', mainRoot: '/', worktree: null, commit: '', platform: 'macos', status: 'running', error: null, failure: null, startedAt: Date.now(), ownerPid: 999_999, agentJob, supervisorPid: null, serverUrl: '', adminSecret: '', control: null, pids: {}, exited: {}, container: null, plan: null };
}

describe('ogw agent stop', () => {
  it('ends the agent job and stops the instances its agent started, and no other', async () => {
    const ws = makeWorkspace();
    await jobRecord(ws.env, 'agentstop1', 'agent', { role: 'content', output: join(ws.root, 'out.md'), runLog: join(ws.root, 'out-runs.json') });
    await writeRecord(instance('mineinst1', 'agentstop1'), ws.env);
    // a job the agent started: in the agent's job index, with the agent as its agentJob
    await jobRecord(ws.env, 'subjob1', 'check');
    const subFile = join(await jobsDir(ws.env), 'subjob1.json');
    writeFileSync(subFile, JSON.stringify({ ...(JSON.parse(readFileSync(subFile, 'utf8')) as object), agentJob: 'agentstop1' }));
    mkdirSync(join(await jobsDir(ws.env), 'agent-jobs', 'agentstop1'), { recursive: true });
    writeFileSync(join(await jobsDir(ws.env), 'agent-jobs', 'agentstop1', 'subjob1'), '');
    await writeRecord(instance('otherinst', 'agentother'), ws.env);
    const out = await ogw(ws, ['agent', 'stop', 'agentstop1']);
    expect(out.stderr).toBe('');
    expect(out.stdout).toBe('agentstop1 failed\nstopped instance mineinst1\n');
    expect((await readJob('agentstop1', ws.env)).status).toBe('failed');
    expect((await readJob('subjob1', ws.env)).status).toBe('failed');
    expect((await listRecords(ws.env)).map((r) => r.id)).toEqual(['otherinst']);
  });

  it('refuses a job that is not an ogw agent job, and leaves it running', async () => {
    const ws = makeWorkspace();
    await jobRecord(ws.env, 'checkjob1', 'check');
    const out = await ogw(ws, ['agent', 'stop', 'checkjob1']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('not an ogw agent job: checkjob1');
    expect((await readJob('checkjob1', ws.env)).status).toBe('running');
  });
});
