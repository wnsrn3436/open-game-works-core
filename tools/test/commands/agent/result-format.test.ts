import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startAgentJob } from '../../../src/commands/agent/api.ts';
import { formatReviewInput } from '../../../src/commands/review/lib/input.ts';
import { createContext } from '../../../src/lib/command.ts';
import { readJob } from '../../../src/lib/jobs.ts';
import { makeGame, makeWorkspace, ogw, sh } from '../../helpers/workspace.ts';
import { reviewFile } from '../review/review-fixture.ts';
import { fakeAgentCli, gameWithRun, RESULT, runAgent, type FakeCall } from './helpers.ts';

/** Real output of the agent CLIs on this host (`test/commands/agent/lib/usage.test.ts`). */
function usageFixture(name: string): string {
  return join(import.meta.dirname, '..', '..', 'fixtures', 'agent-usage', name);
}

/** The prompt of a fix round of the result file `output` with `errors` (ogw.md `### result format` of `## agent`). */
function fixPrompt(output: string, errors: string[]): string {
  return `The result file ${output} is not in its format. Fix only these format errors in it, commit it when your procedure commits it, and end:\n${errors.map((error) => `- ${error}\n`).join('')}`;
}

/** Fake agent CLI behavior: `files[n]` is the result file run `n` (from 1) of the job writes; the last one for later runs. */
function writesByRun(files: string[], extra = ''): string {
  return [
    // the runs of one job share the folder the agent starts in: the run number is kept there
    "const n = (fs.existsSync('.runs') ? Number(fs.readFileSync('.runs', 'utf8')) : 0) + 1; fs.writeFileSync('.runs', String(n));",
    `const files = ${JSON.stringify(files)};`,
    extra,
    'fs.writeFileSync(output, files[Math.min(n, files.length) - 1]);',
  ].join('\n');
}

const BAD_DEFECTS = '## defects\n\n| id | result | note |\n|---|---|---|\n| d1 | done | |\n';

describe('ogw agent: result format', () => {
  it('continues the Claude Code session of the job with the format errors until the result file is in its format, and counts every run in the usage', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'records/loops/r1/content-input-1.md': '## kind\ncompleteness\n' });
    const printed = `process.stdout.write(fs.readFileSync(process.argv.includes('--resume') ? ${JSON.stringify(usageFixture('claude-session-resumed.json'))} : ${JSON.stringify(usageFixture('claude-session-new.json'))}, 'utf8'));`;
    const fake = fakeAgentCli(ws, writesByRun([BAD_DEFECTS, RESULT], printed));
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'records/loops/r1/content-input-1.md')], fake.env, root);
    const output = join(root, 'records/loops/r1/content-1.md');
    expect(waited).toMatchObject({ code: 0, stdout: `${output}\n` });
    const calls = fake.calls();
    expect(calls).toHaveLength(2);
    const [first, fix] = calls as [FakeCall, FakeCall];
    const session = first.argv[first.argv.indexOf('--session-id') + 1] as string;
    // the same CLI, options and folder, the session of the job continued, with the format errors
    expect(fix.argv).toEqual([...first.argv.slice(0, first.argv.indexOf('--session-id')), '--resume', session]);
    expect(fix.cwd).toBe(first.cwd);
    expect(fix.prompt).toBe(fixPrompt(output, ['`## defects` row d1: result `done` is not one of fixed, refused, not reproduced, not done']));
    // the result object of the last run has the totals of the session: the usage of both runs; the turns of both runs
    const { meta } = await readJob(id, ws.env);
    expect(meta.usage).toEqual({ cli: 'claude-code', model: 'claude-opus-5-5', effort: 'high', inputTokens: 63305, cachedTokens: 57939, outputTokens: 112, costUsd: 0.0170679, costUnknown: null, turns: 2 });
    expect(meta.sessionUsage).toEqual({ inputTokens: 63305, cachedTokens: 57939, outputTokens: 112, costUsd: 0.0170679 });
  });

  it('fails the job with the format errors left after harness settings resultFixRounds fix rounds', async () => {
    for (const rounds of [0, 2]) {
      const ws = makeWorkspace({ resultFixRounds: rounds });
      const { root } = await gameWithRun(ws, { 'in.md': '## kind\ncompleteness\n' });
      const fake = fakeAgentCli(ws, "fs.writeFileSync(output, 'a report without its sections\\n');");
      const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
      expect(fake.calls()).toHaveLength(rounds + 1);
      expect(waited.code).toBe(1);
      expect(waited.stdout).toContain(`failed: result file: \`## defects\` is missing\noutput: ${join(root, 'records/loops/r1/content-1.md')}`);
      expect((await ogw(ws, ['agent', 'status', id])).stdout).toBe('failed\n');
    }
  });

  it('fails a fix round that ends with another exit code as a first run would', async () => {
    const ws = makeWorkspace({ resultFixRounds: 2 });
    const { root } = await gameWithRun(ws, { 'in.md': '## kind\ncompleteness\n' });
    const fake = fakeAgentCli(ws, writesByRun(['no sections\n'], "if (process.argv.includes('--resume')) process.exitCode = 4;"));
    const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(fake.calls()).toHaveLength(2);
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain('failed: agent CLI ended with code 4\n');
  });

  it('takes any note of a fixed row', async () => {
    const ws = makeWorkspace({ resultFixRounds: 3 });
    const input = [
      '## kind', '', 'completeness', '', '## defects', '',
      '| id | severity | owner | where | what | why | evidence | source | status |', '|---|---|---|---|---|---|---|---|---|',
      '| crash | major | client content | boss | crash | x | e | play | open |', '| flat | minor | client content | hud | flat | x | e | judge | open |', '',
    ].join('\n');
    const { root } = await gameWithRun(ws, { 'in.md': input });
    const report = ['## defects', '', '| id | result | note |', '|---|---|---|', '| crash | fixed | |', '| flat | fixed | it looks better |', ''].join('\n');
    const fake = fakeAgentCli(ws, writesByRun([report]));
    const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(0);
    expect(fake.calls()).toHaveLength(1);
  });

  it('checks the hypothesis moment of a fun iteration against the judge moments of the request of the run', async () => {
    const ws = makeWorkspace({ resultFixRounds: 2 });
    const { root } = await gameWithRun(ws, {
      'records/loops/r1/request.md': '## request\n\nx\n\n## judge moments\n\n- `boss`: the first boss\n',
      'in.md': '## kind\nfun\n',
    });
    const report = (moment: string): string => `## hypothesis\n\n${moment}\n\n## defects\n\nnone\n`;
    const fake = fakeAgentCli(ws, writesByRun([report('- element: game feel'), report('- moment: bos'), report('- moment: `boss`')]));
    const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(0);
    const output = join(root, 'records/loops/r1/content-1.md');
    expect(fake.calls().slice(1).map((call) => call.prompt)).toEqual([
      fixPrompt(output, ['`## hypothesis` has no `- moment: <name>` line']),
      fixPrompt(output, [`\`## hypothesis\` moment \`bos\` is neither \`none\` nor a moment of \`## judge moments\` of ${join(root, 'records/loops/r1/request.md')} (boss)`]),
    ]);
    // a completeness iteration has no moment to name
    writeFileSync(join(root, 'in.md'), '## kind\ncompleteness\n');
    const plain = fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(report('none'))});`);
    expect((await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], plain.env, root)).waited.code).toBe(0);
    expect(plain.calls()).toHaveLength(1);
  });

  it('continues a Codex session with codex exec resume and the thread of its first run, and takes the session totals of the last run', async () => {
    const ws = makeWorkspace({ resultFixRounds: 2 });
    const { root } = await gameWithRun(ws, { 'in.md': '## kind\ncompleteness\n' });
    const thread = '01a1b10a-4e30-7ec1-b0cc-8edbc88619e9';
    const events = [
      "const usage = [{ input_tokens: 100, cached_input_tokens: 40, output_tokens: 5 }, { input_tokens: 250, cached_input_tokens: 120, output_tokens: 9 }, { input_tokens: 400, cached_input_tokens: 200, output_tokens: 14 }][n - 1];",
      // a resumed run names a thread too: the fix rounds continue the one of the first run
      `process.stdout.write(JSON.stringify({ type: 'thread.started', thread_id: n === 1 ? '${thread}' : 'thread-' + String(n) }) + '\\n' + JSON.stringify({ type: 'turn.completed', usage }) + '\\n');`,
    ].join('\n');
    const fake = fakeAgentCli(ws, writesByRun(['no sections\n', 'no sections\n', RESULT], events));
    const ctx = createContext({ cwd: root, env: { ...ws.env, ...fake.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const id = await startAgentJob(ctx, { role: 'content', game: 'g', input: join(root, 'in.md'), agent: { cli: 'codex', model: 'gpt-x', effort: 'low' } });
    expect((await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env })).code).toBe(0);
    const resume = ['exec', 'resume', '--model', 'gpt-x', '-c', 'model_reasoning_effort="low"', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', thread, '-'];
    expect(fake.calls().map((call) => call.argv)).toEqual([
      ['exec', '--model', 'gpt-x', '-c', 'model_reasoning_effort="low"', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json', '-'],
      resume,
      resume,
    ]);
    expect((await readJob(id, ws.env)).meta.usage).toEqual({ cli: 'codex', model: 'gpt-x', effort: 'low', inputTokens: 400, cachedTokens: 200, outputTokens: 14, costUsd: null, costUnknown: 'codex prints no money cost', turns: null });
    // the session of the job is the thread of its first run
    expect((await readJob(id, ws.env)).meta.session).toEqual({ id: thread, resume: false });
  });

  it('has no fix round for a Codex job whose first run printed no thread', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': '## kind\ncompleteness\n' });
    const fake = fakeAgentCli(ws, "fs.writeFileSync(output, 'no sections\\n');");
    const ctx = createContext({ cwd: root, env: { ...ws.env, ...fake.env }, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const id = await startAgentJob(ctx, { role: 'content', game: 'g', input: join(root, 'in.md'), agent: { cli: 'codex', model: 'gpt-x', effort: 'low' } });
    const waited = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000'], { env: fake.env });
    expect(waited.code).toBe(1);
    expect(waited.stdout).toContain('failed: result file: `## defects` is missing');
    expect(fake.calls()).toHaveLength(1);
  });

  it('starts a hardening agent with a new Claude Code session, which its fix round continues in its worktree', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': 'x', 'server/a.ts': 'a\n' }, { kind: 'build', env: 'DEV', version: '1.0.0', branch: 'build/dev-1.0.0' });
    const commit = "execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'record ' + String(n)]);";
    const record = (fixes: string): string => `## changes\n\nnone\n\n## content agent fixes\n\n${fixes}\n\n## unknown\n\nnone\n`;
    const fake = fakeAgentCli(ws, `${writesByRun([record('the owner of a.ts'), record('none')])}\n${commit}`);
    const { id, waited } = await runAgent(ws, ['server-hardening', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(0);
    const calls = fake.calls();
    expect(calls).toHaveLength(2);
    const [first, fix] = calls as [FakeCall, FakeCall];
    const session = first.argv[first.argv.indexOf('--session-id') + 1] as string;
    expect(session).toMatch(/^[0-9a-f-]{36}$/);
    expect(fix.argv.slice(-2)).toEqual(['--resume', session]);
    expect(fix.cwd).toBe(join(ws.worktrees, 'g', `agent-${id}`));
    const output = waited.stdout.trim();
    expect(fix.prompt).toBe(fixPrompt(output, ['`## content agent fixes` is neither `none` nor a table with the columns file:line, owner, problem, task']));
    expect(sh(root, 'git', ['show', `agent/${id}:${output.slice(fix.cwd.length + 1)}`])).toBe(record('none'));
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('runs a fix round in the sandbox of its first run, which blocks the other games', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'in.md': '## kind\ncompleteness\n' });
    const other = makeGame(ws, 'other', { 'settings.json': {}, 'secret.txt': 'hidden' });
    const read = `const seen = (() => { try { return fs.readFileSync(${JSON.stringify(join(other, 'secret.txt'))}, 'utf8'); } catch { return 'blocked'; } })();`;
    const fake = fakeAgentCli(ws, `${read}\nfs.writeFileSync(output, fixRound ? '<!-- ' + seen + ' -->\\n' + ${JSON.stringify(RESULT)} : 'no sections\\n');`);
    const { waited } = await runAgent(ws, ['content', '--game', 'g', '--input', join(root, 'in.md')], fake.env, root);
    expect(waited.code).toBe(0);
    expect(fake.calls()).toHaveLength(2);
    expect(readFileSync(join(root, 'records/loops/r1/content-1.md'), 'utf8').split('\n')[0]).toBe('<!-- blocked -->');
  });

  it('checks a review file against its input: its form, the low findings of a review of changes, and the review list rows', async () => {
    const ws = makeWorkspace({ resultFixRounds: 2 });
    const input = join(ws.root, 'review-input.md');
    writeFileSync(input, formatReviewInput({ side: 'tool', target: 'agent merge', round: 1, definitions: [], previousReview: null, commitRange: 'a..b', coreReports: [], debt: ['D1: src/a.ts:3: medium p'] }));
    const low = '| R1-1 | correctness | low | src/a.ts:3 | run x | check y | no | 90 |';
    const fixed = '| D1 | fixed | none | gone |';
    const fake = fakeAgentCli(ws, writesByRun([reviewFile([low], [], [], [fixed]), reviewFile([], []), reviewFile([], [], [], [fixed])]));
    const { waited } = await runAgent(ws, ['review', '--input', input], fake.env);
    expect(waited.code).toBe(0);
    const output = waited.stdout.trim();
    const [first, ...fixes] = fake.calls();
    expect(first?.argv).toContain('--session-id');
    expect(fixes.map((call) => call.prompt)).toEqual([
      fixPrompt(output, ['`## findings` row `R1-1`: severity `low` is not one of `critical`, `high`, `medium`']),
      fixPrompt(output, ['## debt rows none do not answer the debt items D1']),
    ]);
  });
});
