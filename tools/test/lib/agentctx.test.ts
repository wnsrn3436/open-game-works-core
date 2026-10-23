import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentCliEnded, agentContext, markAgentRunning, newAgentKey, recordJobEnd } from '../../src/lib/agentctx.ts';
import { jobWorkspace, writeJob } from '../commands/job/helpers.ts';

function agentWithRunLog(jobs: string, root: string, id: string, cliPid: number | null = null): string {
  const folder = join(root, `agent-${id}`, 'records');
  mkdirSync(folder, { recursive: true });
  const runLog = join(folder, 'content-1-runs.json');
  writeJob(jobs, { id, command: 'agent', argv: ['agent', '__run'], meta: { role: 'content', cliPid, output: join(folder, 'content-1.md'), runLog } });
  return runLog;
}

function writeRunLog(runLog: string, job: string): void {
  writeFileSync(runLog, JSON.stringify({ runs: [{ command: 'ogw core test server', startedAt: 1, exitCode: null, summary: null, job }] }));
}

describe('agent run log of background jobs', () => {
  it('fills the exit code and summary of a background job that ends while the agent CLI runs', async () => {
    const ws = jobWorkspace();
    const runLog = agentWithRunLog(ws.jobs, ws.root, 'ag1');
    writeRunLog(runLog, 'bg1');
    writeJob(ws.jobs, { id: 'bg1', command: 'core test', agentJob: 'ag1', status: 'done', exitCode: 0, endedAt: 9, summary: { tests: 3, passed: 3 } });
    await recordJobEnd('bg1', ws.env);
    expect(JSON.parse(readFileSync(runLog, 'utf8'))).toEqual({
      runs: [{ command: 'ogw core test server', startedAt: 1, exitCode: 0, summary: { tests: 3, passed: 3 }, job: 'bg1' }],
    });
  });

  it('keeps exit code null for a job that ends after the agent CLI ended, and brings back no removed folder', async () => {
    const ws = jobWorkspace();
    const runLog = agentWithRunLog(ws.jobs, ws.root, 'ag2');
    writeRunLog(runLog, 'bg2');
    const before = readFileSync(runLog, 'utf8');
    writeJob(ws.jobs, { id: 'bg2', command: 'core test', agentJob: 'ag2', status: 'failed', exitCode: 1, endedAt: 9, summary: { tests: 2, passed: 1 } });
    await agentCliEnded('ag2', ws.env);
    await recordJobEnd('bg2', ws.env);
    expect(readFileSync(runLog, 'utf8')).toBe(before);
    rmSync(join(ws.root, 'agent-ag2'), { recursive: true });
    await recordJobEnd('bg2', ws.env);
    expect(existsSync(join(ws.root, 'agent-ag2'))).toBe(false);
  });

  it('changes nothing when the agent job is no longer running', async () => {
    const ws = jobWorkspace();
    const runLog = agentWithRunLog(ws.jobs, ws.root, 'ag3');
    writeJob(ws.jobs, { id: 'ag3', command: 'agent', status: 'done', exitCode: 0, endedAt: 5, meta: { role: 'content', cliPid: null, runLog } });
    writeRunLog(runLog, 'bg3');
    const before = readFileSync(runLog, 'utf8');
    writeJob(ws.jobs, { id: 'bg3', command: 'check', agentJob: 'ag3', status: 'done', exitCode: 0, endedAt: 9 });
    await recordJobEnd('bg3', ws.env);
    expect(readFileSync(runLog, 'utf8')).toBe(before);
  });
});

describe('agentContext', () => {
  it('finds the agent whose CLI is an ancestor among the running agents of the index only', async () => {
    const ws = jobWorkspace();
    agentWithRunLog(ws.jobs, ws.root, 'ag4', process.ppid);
    expect(await agentContext(ws.env)).toBeNull();
    await markAgentRunning('ag4', ws.env);
    expect((await agentContext(ws.env))?.job.id).toBe('ag4');
    await agentCliEnded('ag4', ws.env);
    expect(await agentContext(ws.env)).toBeNull();
  });

  it('removes index entries of jobs that are not running', async () => {
    const ws = jobWorkspace();
    agentWithRunLog(ws.jobs, ws.root, 'ag5', process.pid);
    await markAgentRunning('ag5', ws.env);
    await markAgentRunning('gone5', ws.env);
    writeJob(ws.jobs, { id: 'ag5', command: 'agent', status: 'failed', exitCode: 1, endedAt: 5, meta: { role: 'content', cliPid: process.pid, runLog: 'x' } });
    expect(await agentContext(ws.env)).toBeNull();
    expect(existsSync(join(ws.jobs, 'running-agents', 'ag5'))).toBe(false);
    expect(existsSync(join(ws.jobs, 'running-agents', 'gone5'))).toBe(false);
  });

  it('lists jobs past files that are not job records, and fails on a record that cannot be read', async () => {
    const ws = jobWorkspace();
    const { listJobs } = await import('../../src/lib/jobs.ts');
    writeJob(ws.jobs, { id: 'ok11', command: 'agent' });
    writeFileSync(join(ws.jobs, 'notes-file.json'), '{');
    expect((await listJobs(ws.env)).map((job) => job.id)).toEqual(['ok11']);
    writeFileSync(join(ws.jobs, 'bad11.json'), '{');
    await expect(listJobs(ws.env)).rejects.toThrow();
  });

  it('fails, and keeps the running entry, when a job record of the index cannot be read', async () => {
    const ws = jobWorkspace();
    await markAgentRunning('ag10', ws.env);
    // a record that does not parse is not a job that is gone
    writeFileSync(join(ws.jobs, 'ag10.json'), '{');
    await expect(agentContext(ws.env)).rejects.toThrow();
    expect(existsSync(join(ws.jobs, 'running-agents', 'ag10'))).toBe(true);
  });
});

describe('agentContext by agent key', () => {
  function keyedAgent(ws: { jobs: string; root: string }, id: string, fields: { cliPid?: number | null; pidNs?: string | null } = {}): string {
    const key = newAgentKey(id);
    writeJob(ws.jobs, {
      id,
      command: 'agent',
      argv: ['agent', '__run'],
      ...(fields.pidNs === undefined ? {} : { pidNs: fields.pidNs }),
      meta: { role: 'play', cliPid: fields.cliPid ?? null, output: join(ws.root, `${id}.md`), runLog: join(ws.root, `${id}-runs.json`), keyHash: key.hash },
    });
    return key.value;
  }

  it('finds a sandboxed agent by its key, and not by a forged or another agent key', async () => {
    const ws = jobWorkspace();
    const key = keyedAgent(ws, 'ag6');
    const other = keyedAgent(ws, 'ag7');
    await markAgentRunning('ag6', ws.env);
    await markAgentRunning('ag7', ws.env);
    expect((await agentContext({ ...ws.env, OGW_AGENT_KEY: key }))?.job.id).toBe('ag6');
    expect((await agentContext({ ...ws.env, OGW_AGENT_KEY: other }))?.job.id).toBe('ag7');
    // the job record holds only the hash: an agent cannot claim another agent with its own nonce or a guess
    const nonce = key.slice('ag6.'.length);
    expect(readFileSync(join(ws.jobs, 'ag6.json'), 'utf8')).not.toContain(nonce);
    expect(await agentContext({ ...ws.env, OGW_AGENT_KEY: `ag7.${nonce}` })).toBeNull();
    expect(await agentContext({ ...ws.env, OGW_AGENT_KEY: 'ag6.x' })).toBeNull();
    expect(await agentContext({ ...ws.env, OGW_AGENT_KEY: 'ag6' })).toBeNull();
    expect(await agentContext({ ...ws.env, OGW_AGENT_KEY: '../ag6.x' })).toBeNull();
    // an unchecked job id names no agent
    expect(await agentContext({ ...ws.env, OGW_AGENT_JOB: 'ag6' })).toBeNull();
    await agentCliEnded('ag6', ws.env);
    expect((await agentContext({ ...ws.env, OGW_AGENT_KEY: key }))?.job.id).toBe('ag6');
  });

  it('uses ancestor pids only of agents of its own PID namespace', async () => {
    const ws = jobWorkspace();
    const key = keyedAgent(ws, 'ag8', { cliPid: process.ppid, pidNs: '111' });
    keyedAgent(ws, 'ag9', { cliPid: process.ppid, pidNs: '222' });
    await markAgentRunning('ag8', ws.env);
    await markAgentRunning('ag9', ws.env);
    expect((await agentContext(ws.env, '222'))?.job.id).toBe('ag9');
    // in the sandbox's namespace the outer CLI pid means nothing: the key decides
    expect((await agentContext({ ...ws.env, OGW_AGENT_KEY: key }, '333'))?.job.id).toBe('ag8');
    expect(await agentContext(ws.env, '333')).toBeNull();
  });
});
