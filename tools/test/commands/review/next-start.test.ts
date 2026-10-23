import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type * as Git from '../../../src/lib/git.ts';
import type * as Jobs from '../../../src/lib/jobs.ts';
import { listJobs, readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli } from '../agent/helpers.ts';

/** Faults the tests turn on: a commit that lands after the first HEAD read, and a code check job that cannot start. */
const faults = vi.hoisted(() => ({ commitAfterHead: null as string | null, failCodeCheckStart: false }));

vi.mock('../../../src/lib/git.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Git>();
  return {
    ...real,
    async head(cwd: string, options?: Git.GitOptions): Promise<string> {
      const commit = await real.head(cwd, options);
      const repo = faults.commitAfterHead;
      if (repo !== null) {
        faults.commitAfterHead = null;
        writeFileSync(join(repo, 'landed.txt'), 'landed');
        commitAll(repo, 'landed');
      }
      return commit;
    },
  };
});

vi.mock('../../../src/lib/jobs.ts', async (importOriginal) => {
  const real = await importOriginal<typeof Jobs>();
  return {
    ...real,
    async startJob(options: Jobs.StartJobOptions): Promise<string> {
      if (faults.failCodeCheckStart && options.command === 'code check') throw new Error('cannot write the job record');
      return real.startJob(options);
    },
  };
});

function definitions(ws: TestWorkspace): string[] {
  return ['--since', 'HEAD', '--definition', join(ws.harness, 'tools', 'ogw.md')];
}

const EMPTY_REVIEW = '## findings\n\nnone\n\n## previous\n\nnone\n\n## out of scope\n\nnone\n\n## debt\n\nnone\n\n## must fix\n\nnone\n\n## unknown\n\nnone\n';

function statePath(ws: TestWorkspace): string {
  return join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
}

describe('ogw review next: starting a round', () => {
  it('makes the review worktree at the start commit it read once, though a commit lands after that read', async () => {
    const ws = makeWorkspace();
    const env = fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(EMPTY_REVIEW)});`).env;
    const before = commitAll(ws.harness, 'before');
    faults.commitAfterHead = ws.harness;
    expect((await ogw(ws, ['review', 'next', 'tool', 'agent', 'merge', ...definitions(ws)], { env })).code).toBe(0);
    const state = JSON.parse(readFileSync(statePath(ws), 'utf8')) as { rounds: { startCommit: string; reviewJob: string }[] };
    const round = state.rounds[0];
    expect(round?.startCommit).toBe(before);
    const place = ((await readJob(round?.reviewJob as string, ws.env)).meta as { place: { baseCommit: string } }).place;
    expect(place.baseCommit).toBe(before);
    expect((await ogw(ws, ['review', 'wait', 'tool', 'agent', 'merge', '--timeout', '120000'])).stdout).toBe('result: done\nround: 1\n');
  });

  it('stops the review agent and removes its review file when the code check job cannot start', async () => {
    const ws = makeWorkspace();
    const env = fakeAgentCli(ws, `await new Promise((r) => setTimeout(r, 20000)); fs.writeFileSync(output, ${JSON.stringify(EMPTY_REVIEW)});`).env;
    faults.failCodeCheckStart = true;
    try {
      const failed = await ogw(ws, ['review', 'next', 'tool', 'agent', 'merge', ...definitions(ws)], { env });
      expect(failed.code).not.toBe(0);
      expect(failed.stderr).toContain('cannot write the job record');
    } finally {
      faults.failCodeCheckStart = false;
    }
    const reviews = (await listJobs(ws.env)).filter((job) => job.command === 'agent' && job.meta.role === 'review');
    expect(reviews).toHaveLength(1);
    const review = reviews[0] as Jobs.JobRecord;
    expect(review.status).toBe('failed');
    expect(existsSync(dirname(review.meta.output as string))).toBe(false);
    expect(existsSync(statePath(ws))).toBe(false);

    const quick = fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(EMPTY_REVIEW)});`).env;
    const started = await ogw(ws, ['review', 'next', 'tool', 'agent', 'merge', ...definitions(ws)], { env: quick });
    expect(started.stdout).toContain('round: 1');
    expect((await ogw(ws, ['review', 'wait', 'tool', 'agent', 'merge', '--timeout', '120000'])).stdout).toBe('result: done\nround: 1\n');
  });
});
