// First calls of the judge play budget that overlap: a call meets the write of another one. Node writes a file by
// emptying it first, so the fake write stops there until the test lets it go on.
import { readdirSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { checkPlayBudget, playBudgetDeps } from '../../../src/commands/agent/lib/play-budget.ts';
import { newAgentKey } from '../../../src/lib/agentctx.ts';
import { createContext } from '../../../src/lib/command.ts';
import { jobsDir } from '../../../src/lib/jobs.ts';
import { fakeAgentJob } from '../instance/agents.ts';
import { jobWorkspace } from '../job/helpers.ts';

const gate = vi.hoisted(() => ({ held: null as ((resume: () => void) => void) | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile: typeof real.writeFile = async (file, data, options) => {
    const held = gate.held;
    if (held !== null && typeof file === 'string' && file.includes('play-budget')) {
      await real.writeFile(file, '');
      await new Promise<void>((resume) => {
        held(resume);
      });
    }
    await real.writeFile(file, data, options);
  };
  return { ...real, writeFile };
});

const saved = { ...playBudgetDeps };
afterEach(() => {
  Object.assign(playBudgetDeps, saved);
  gate.held = null;
});

describe('judge play budget of first calls that overlap', () => {
  it('refuses neither call, keeps the time of the first one, and leaves only the budget file', async () => {
    const ws = jobWorkspace();
    const tmp = await newTempFolder('ogw-judge-');
    const key = newAgentKey('agentjudge8');
    const remove = await fakeAgentJob(ws.env, 'agentjudge8', { role: 'judge', cliPid: null, keyHash: key.hash, folder: tmp });
    const ctx = createContext({ cwd: ws.root, env: { ...ws.env, OGW_AGENT_KEY: key.value }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const resumes: (() => void)[] = [];
    let arrived = (): void => undefined;
    gate.held = (resume) => {
      resumes.push(resume);
      arrived();
    };
    const writing = (count: number): Promise<void> => new Promise((resolve) => {
      arrived = () => {
        if (resumes.length >= count) resolve();
      };
      arrived();
    });
    const start = 1_000_000;
    let now = start;
    playBudgetDeps.now = () => now;
    try {
      const first = checkPlayBudget(ctx, undefined, 'insta');
      await writing(1);
      now = start + 1;
      const second = checkPlayBudget(ctx, undefined, 'insta');
      await Promise.race([writing(2), second.catch(() => undefined)]);
      resumes[0]?.();
      await first;
      resumes[1]?.();
      await second;
      const folder = join(await jobsDir(ws.env), 'play-budget', 'judge-agentjudge8');
      expect(readFileSync(join(folder, 'insta'), 'utf8')).toBe(String(start));
      expect(readdirSync(folder)).toEqual(['insta']);
    } finally {
      remove();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
