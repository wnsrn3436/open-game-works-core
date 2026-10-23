import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostBootId, type JobRecord } from '../../../src/lib/jobs.ts';
import { makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';

/** A workspace whose jobs live in `<root>/jobs`, so tests can write job records directly. */
export function jobWorkspace(settingsPatch: Record<string, unknown> = {}): TestWorkspace & { jobs: string } {
  const ws = makeWorkspace(settingsPatch);
  const jobs = join(ws.root, 'jobs');
  mkdirSync(jobs);
  ws.env.OGW_JOBS_DIR = jobs;
  return { ...ws, jobs };
}

/** Writes a job record, and its entry in the index of the jobs of its agent as `startJob` does. */
export function writeJob(jobs: string, fields: Partial<JobRecord> & { id: string }, output: { stdout?: string; stderr?: string } = {}): void {
  const record: JobRecord = {
    argv: ['check', 'g'],
    cwd: '/',
    command: 'check',
    game: null,
    startedAt: Date.now(),
    endedAt: null,
    status: 'running',
    exitCode: null,
    supervisorPid: process.pid,
    pid: null,
    timeLimitMs: 3_600_000,
    agentJob: null,
    summary: null,
    meta: {},
    bootId: hostBootId(),
    ...fields,
  };
  if (record.agentJob !== null) {
    // the index of the jobs of an agent that `startJob` writes
    mkdirSync(join(jobs, 'agent-jobs', record.agentJob), { recursive: true });
    writeFileSync(join(jobs, 'agent-jobs', record.agentJob, fields.id), '');
  }
  writeFileSync(join(jobs, `${fields.id}.json`), JSON.stringify(record));
  const logs = join(jobs, fields.logFolder ?? '');
  if (output.stdout !== undefined || output.stderr !== undefined) mkdirSync(logs, { recursive: true });
  if (output.stdout !== undefined) writeFileSync(join(logs, `${fields.id}.stdout`), output.stdout);
  if (output.stderr !== undefined) writeFileSync(join(logs, `${fields.id}.stderr`), output.stderr);
}
