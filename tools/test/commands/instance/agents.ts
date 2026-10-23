// A fake running `ogw agent` job record, for the play and judge agent rules.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { markAgentRunning } from '../../../src/lib/agentctx.ts';
import { jobsDir } from '../../../src/lib/jobs.ts';

export async function fakeAgentJob(
  env: NodeJS.ProcessEnv,
  id: string,
  meta: { role: string; cliPid: number | null; folder?: string; output?: string; input?: string; instances?: string[]; keyHash?: string },
): Promise<() => void> {
  const dir = await jobsDir(env);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${id}.json`);
  writeFileSync(
    path,
    JSON.stringify({
      id,
      argv: ['agent', meta.role],
      cwd: '/',
      command: 'agent',
      game: 'g',
      startedAt: Date.now(),
      endedAt: null,
      status: 'running',
      exitCode: null,
      supervisorPid: process.pid,
      pid: null,
      timeLimitMs: 60_000,
      agentJob: null,
      summary: null,
      meta: { runLog: join(dir, `${id}-runs.json`), output: meta.output ?? join(dir, `${id}-out.md`), ...meta },
    }),
  );
  await markAgentRunning(id, env);
  return () => {
    rmSync(path, { force: true });
  };
}
