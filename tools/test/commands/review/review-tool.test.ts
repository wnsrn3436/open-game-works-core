import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { lastReviewResults } from '../../../src/commands/review/api.ts';
import { createContext } from '../../../src/lib/command.ts';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { fakeAgentCli } from '../agent/helpers.ts';
import { changeDefinition, finding, mergeDefinitions, next, reviewer, reviewFile, wait } from './review-fixture.ts';

describe('ogw review: tool', () => {
  it('keeps --since for round 1 after an invalid one, and --continue until a round it started is judged', async () => {
    const ws = makeWorkspace();
    const since = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(ws.harness, 'skills', 'later.md'), 'x');
    const head = commitAll(ws.harness, 'later');
    const defs = mergeDefinitions(ws).slice(2);
    await next(ws, ['tool', 'agent', 'merge', '--since', since, ...defs], reviewer(ws, {}));
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: invalid\nround: 1\n');
    const open = (round: number): string => reviewFile([finding(`R${String(round)}-1`, 'no')]);
    const env = reviewer(ws, { 1: open(1), 2: open(2), 3: open(3), 4: open(4), 5: open(5), 6: open(6) });
    await next(ws, ['tool', 'agent', 'merge', ...defs], env);
    const statePath = join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
    const input = (JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: { input: string }[] }).rounds[0]?.input as string;
    expect(readFileSync(input, 'utf8')).toContain(`## commit range\n\n${since}..${head}\n`);
    await wait(ws, ['tool', 'agent', 'merge']);
    for (let round = 2; round <= 6; round += 1) {
      await next(ws, ['tool', 'agent', 'merge', ...defs], env);
      await wait(ws, ['tool', 'agent', 'merge']);
    }
    // round 7 of --continue is dropped as invalid: the next round goes on with the kept --continue
    await next(ws, ['tool', 'agent', 'merge', '--continue', ...defs], reviewer(ws, {}));
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: invalid\nround: 7\n');
    expect((await next(ws, ['tool', 'agent', 'merge', ...defs], reviewer(ws, { 7: reviewFile([]) }))).stdout).toContain('round: 7');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 7\n');
  }, 180_000);

  it('needs --since for round 1 of a tool target', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([]) });
    const definitions = mergeDefinitions(ws).slice(2);
    expect((await next(ws, ['tool', 'agent', 'merge', ...definitions], env)).stderr).toContain('round 1 of tool target agent merge needs --since');
  });

  it('writes the review input with definitions, previous review and commit range', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'no')]), 2: reviewFile([]) });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    await wait(ws, ['tool', 'agent', 'merge']);
    const state = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json'), 'utf8')) as {
      rounds: { input: string; reviewFile: string; startCommit: string }[];
    };
    const first = state.rounds[0];
    expect(readFileSync(first?.input as string, 'utf8')).toContain(
      `## definition\n\n- ${join(ws.harness, 'tools', 'ogw.md')}\n- ${join(ws.harness, 'skills', 'game-loop', 'SKILL.md')}\n- ${join(ws.harness, 'skills', 'core', 'command.md')}\n\n## previous review\n\nnone\n\n## commit range\n\n${first?.startCommit as string}..${first?.startCommit as string}\n`,
    );
    writeFileSync(join(ws.harness, 'fixed.txt'), 'fixed');
    const fixed = commitAll(ws.harness, 'fix');
    expect(fixed).not.toBe(first?.startCommit);
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    const second = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json'), 'utf8')) as typeof state;
    expect(second.rounds[1]?.startCommit).toBe(fixed);
    const text = readFileSync(second.rounds[1]?.input as string, 'utf8');
    expect(text).toContain(`## previous review\n\n${first?.reviewFile as string}\n\n## commit range\n\n${first?.startCommit as string}..${fixed}\n`);
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 2\n');
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env)).stdout).toBe('done\n');
  });

  it('refuses a tool round without --definition', async () => {
    const ws = makeWorkspace();
    const refused = await next(ws, ['tool', 'review', 'wait'], reviewer(ws, { 1: reviewFile([]) }));
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain('give the documents that define review wait with --definition');
    expect(refused.stderr).toContain('usage: ogw review next tool <target> --definition <file>... [--since <commit>|--debt] [--restart|--respec|--continue|--reopen]\n');
    expect(existsSync(join(ws.harness, '.git', 'ogw-review', 'review wait', 'round-1-input.md'))).toBe(false);
  });

  it('uses --definition files and refuses a round before the last one is judged', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([]) });
    writeFileSync(join(ws.root, 'def.md'), '# def');
    expect((await next(ws, ['tool', 'agent', 'merge', '--definition', join(ws.root, 'missing.md')], env)).stderr).toContain('definition file not found');
    await next(ws, ['tool', 'agent', 'merge', '--since', 'HEAD', '--definition', join(ws.root, 'def.md')], env);
    const refused = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain('round 1 of agent merge has not been judged by ogw review wait');
    const state = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json'), 'utf8')) as { rounds: { input: string }[] };
    expect(readFileSync(state.rounds[0]?.input as string, 'utf8')).toContain(`## definition\n\n- ${join(ws.root, 'def.md')}\n`);
    await wait(ws, ['tool', 'agent', 'merge']);
    appendFileSync(join(ws.root, 'def.md'), '\nchanged');
    expect((await next(ws, ['tool', 'agent', 'merge', '--restart', ...mergeDefinitions(ws)], env)).stdout).toContain('round: 1');
    await wait(ws, ['tool', 'agent', 'merge']);
  });

  it('judges a missing or malformed review file invalid and restarts that round', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: '## findings\n\nsomething\n' });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    const invalid = await wait(ws, ['tool', 'agent', 'merge']);
    expect(invalid).toMatchObject({ code: 1, stdout: 'result: invalid\nround: 1\n' });
    const again = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], reviewer(ws, { 1: reviewFile([]) }));
    expect(again.stdout).toContain('round: 1');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
  });

  it('prints running with 75 while the jobs run, and fails without a round', async () => {
    const ws = makeWorkspace();
    expect((await ogw(ws, ['review', 'wait', 'tool', 'agent', 'merge'])).stderr).toContain('no review round of agent merge');
    const slow = fakeAgentCli(ws, "await new Promise((r) => setTimeout(r, 3000)); fs.writeFileSync(output, '## findings\\n\\nnone\\n\\n## previous\\n\\nnone\\n\\n## out of scope\\n\\nnone\\n\\n## debt\\n\\nnone\\n\\n## must fix\\n\\nnone\\n\\n## unknown\\n\\nnone\\n');").env;
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], slow);
    expect(await ogw(ws, ['review', 'wait', 'tool', 'agent', 'merge', '--timeout', '0'])).toMatchObject({ code: 75, stdout: 'running\n' });
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
  });

  it('clears the tool review state and review files', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([]) });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    await wait(ws, ['tool', 'agent', 'merge']);
    const state = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json'), 'utf8')) as { rounds: { reviewFile: string }[] };
    const file = state.rounds[0]?.reviewFile as string;
    expect(existsSync(file)).toBe(true);
    expect(await ogw(ws, ['review', 'clear', 'tool'])).toMatchObject({ code: 0, stdout: 'cleared tool review state\n' });
    expect(existsSync(file)).toBe(false);
    expect(existsSync(join(ws.harness, '.git', 'ogw-review'))).toBe(false);
    expect((await ogw(ws, ['review', 'clear', 'other'])).stderr).toContain('usage: ogw review clear');
  });

  it('starts a tool round only when tools/ of the harness repo has no changes', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([]) });
    writeFileSync(join(ws.harness, 'tools', 'new.ts'), 'export const x = 1;\n');
    const refused = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect(refused).toMatchObject({ code: 1 });
    expect(refused.stderr).toContain(`${join(ws.harness, 'tools')} has changes that are not committed`);
    expect(refused.stderr).toContain('?? tools/new.ts');
    writeFileSync(join(ws.harness, 'tools', 'ogw.md'), 'changed\n');
    rmSync(join(ws.harness, 'tools', 'new.ts'));
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env)).stderr).toContain(' M tools/ogw.md');
    const head = commitAll(ws.harness, 'tools');
    writeFileSync(join(ws.harness, 'outside.txt'), 'not checked');
    expect((await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env)).code).toBe(0);
    const state = JSON.parse(readFileSync(join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json'), 'utf8')) as { rounds: { startCommit: string }[] };
    expect(state.rounds[0]?.startCommit).toBe(head);
    await wait(ws, ['tool', 'agent', 'merge']);
  });

  it('runs the tool code check on the start commit, not on tools/ changes made while it runs', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([]) });
    const started = await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    expect(started.code).toBe(0);
    writeFileSync(join(ws.harness, 'tools', 'committed.ts'), "export const n: number = 'text';\n");
    commitAll(ws.harness, 'later');
    writeFileSync(join(ws.harness, 'tools', 'edited.ts'), "export const m: number = 'text';\n");
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toBe('result: done\nround: 1\n');
  });

  it('removes the review files of the dropped rounds on --restart and on an invalid round, and refuses --restart while a round runs', async () => {
    const ws = makeWorkspace();
    const statePath = join(ws.harness, '.git', 'ogw-review', 'agent merge', 'state.json');
    const reviewFolder = async (): Promise<string> => {
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as { rounds: { reviewJob: string }[] };
      return dirname((await readJob(state.rounds.at(-1)?.reviewJob as string, ws.env)).meta.output as string);
    };
    const env = reviewer(ws, { 1: reviewFile([finding('R1-1', 'no')]) });
    await next(ws, ['tool', 'agent', 'merge', ...mergeDefinitions(ws)], env);
    const first = await reviewFolder();
    expect(first).toMatch(/ogw-review-file-/);
    const running = await next(ws, ['tool', 'agent', 'merge', '--restart', ...mergeDefinitions(ws)], env);
    expect(running).toMatchObject({ code: 1 });
    expect(running.stderr).toContain('round 1 of agent merge has not been judged by ogw review wait');
    expect((await wait(ws, ['tool', 'agent', 'merge'])).stdout).toContain('result: fix');
    expect(existsSync(first)).toBe(true);
    changeDefinition(ws);
    await next(ws, ['tool', 'agent', 'merge', '--restart', ...mergeDefinitions(ws)], reviewer(ws, {}));
    expect(existsSync(first)).toBe(false);
    const second = await reviewFolder();
    expect(existsSync(second)).toBe(true);
    expect(await wait(ws, ['tool', 'agent', 'merge'])).toMatchObject({ code: 1, stdout: 'result: invalid\nround: 1\n' });
    expect(existsSync(second)).toBe(false);
  });

  it('lists only folders with review state as targets, not a left lock folder', async () => {
    const ws = makeWorkspace();
    await next(ws, ['core', 'routing'], reviewer(ws, { 1: reviewFile([]) }));
    await wait(ws, ['core', 'routing']);
    mkdirSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing.lock'));
    writeFileSync(join(ws.coreImpl, '.git', 'ogw-review', 'routing.lock', 'pid'), '1\n');
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await lastReviewResults(ctx, 'core')).toEqual(new Map([['routing', 'done']]));
  });

  it('checks the arguments', async () => {
    const ws = makeWorkspace();
    expect((await ogw(ws, ['review', 'next', 'tool'])).stderr).toContain('usage: ogw review next');
    expect((await ogw(ws, ['review', 'next', 'core', '../x'])).stderr).toContain('invalid review target');
    expect((await ogw(ws, ['review', 'next', 'tool', 'no', 'such'])).stderr).toContain('give the documents that define no such with --definition');
    expect((await ogw(ws, ['review', 'next', 'core', 'NoModule'])).stderr).toContain('unknown core review target: NoModule');
  });
});
