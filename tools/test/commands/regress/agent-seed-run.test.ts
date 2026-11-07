import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { prepareMain } from '../../../src/commands/judge/lib/guard.ts';
import { writeMark } from '../../../src/commands/regress/lib/mark.ts';
import { readJob } from '../../../src/lib/jobs.ts';
import { changeRuns, newRunState } from '../../../src/lib/runstate.ts';
import { ogw, makeGame, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli, runAgent } from '../agent/helpers.ts';
import { ctxOf } from './helpers.ts';

const REPORT = '## defects\\n\\n| id | result | note |\\n|---|---|---|\\n| leak | not done | no time |\\n';

/** A fix repo `g` with the regression mark and seed-run records holding a content input of iteration 1. */
async function markedGame(ws: TestWorkspace, mark = true): Promise<string> {
  const root = makeGame(ws, 'g', {
    'settings.json': {},
    'records/loops/regress-1-1/content-input-1.md': '## kind\n\ncompleteness\n\n## request\n\nnone\n\n## previous record\n\nnone\n\n## defects\n\n| id | severity | owner | where | what | why | evidence | source | status |\n|---|---|---|---|---|---|---|---|---|\n| leak | blocker | client content | step 2 | leak | w | e | check | open |\n',
    'records/loops/regress-1-1/translation-input-en-55.md': 'en\n',
  });
  if (mark) await writeMark(join(root, '.git'), { kind: 'fix', state: 's' });
  return root;
}

describe('ogw agent --seed-run', () => {
  it('starts a content agent outside a run in the checkout, with the seed-run records, run and iteration lines and a new session', async () => {
    const ws = makeWorkspace();
    const root = await markedGame(ws);
    const fake = fakeAgentCli(ws, `fs.mkdirSync(require('node:path').dirname(output), { recursive: true }); fs.writeFileSync(output, '${REPORT}');`.replace("require('node:path').dirname(output)", "output.slice(0, output.lastIndexOf('/'))"));
    const input = join(root, 'records/loops/regress-1-1/content-input-1.md');
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', input, '--seed-run', 'regress-1-1:1'], fake.env, root);
    const output = join(root, 'records/loops/regress-1-1/content-1.md');
    expect(waited.stderr).toBe('');
    expect(waited.stdout).toBe(`${output}\n`);
    const call = fake.calls().at(-1);
    expect(call?.cwd).toBe(root);
    expect(call?.prompt).toContain(`- input: ${input}\n- output: ${output}\n- run: regress-1-1\n- iteration: 1\n`);
    expect(call?.argv).toContain('--session-id');
    expect((await readJob(id, ws.env)).meta).toMatchObject({ role: 'content', run: 'regress-1-1', iteration: 1, seedRun: { records: 'regress-1-1', iteration: 1 }, place: { kind: 'checkout', dir: root } });
    expect(readFileSync(output, 'utf8')).toContain('| leak | not done | no time |');
  });

  it('is not retried: a fixer that failed makes its seed-run unknown', async () => {
    const ws = makeWorkspace();
    const root = await markedGame(ws);
    const fake = fakeAgentCli(ws, 'process.exit(0);');
    const input = join(root, 'records/loops/regress-1-1/content-input-1.md');
    const { id, waited } = await runAgent(ws, ['content', '--game', 'g', '--input', input, '--seed-run', 'regress-1-1:1'], fake.env, root);
    expect(waited.code).not.toBe(0);
    expect((await ogw(ws, ['agent', 'retry', id], { env: fake.env })).stderr).toContain(`job ${id} is a fixer of a seed-run of ogw regress; it is not retried`);
  });

  it('starts a translation sub-agent in a worktree with the result file in the seed-run records', async () => {
    const ws = makeWorkspace();
    const root = await markedGame(ws);
    const fake = fakeAgentCli(ws, "fs.mkdirSync(output.slice(0, output.lastIndexOf('/')), { recursive: true }); fs.writeFileSync(output, 'done');");
    const input = join(root, 'records/loops/regress-1-1/translation-input-en-55.md');
    const { id, waited } = await runAgent(ws, ['translation', '--game', 'g', '--input', input, '--seed-run', 'regress-1-1:2'], fake.env, root);
    expect(waited.code).toBe(0);
    const meta = (await readJob(id, ws.env)).meta;
    expect(meta).toMatchObject({ role: 'translation', language: 'en', outputRel: 'records/loops/regress-1-1/translation-en-55.md', place: { kind: 'game-worktree', branch: 'main' } });
    expect(fake.calls().at(-1)?.cwd).toBe(join(ws.worktrees, 'g', `agent-${id}`));
  });

  it('is refused outside a regression state or fix repo, with an open run, for other roles and in another form', async () => {
    const ws = makeWorkspace();
    const root = await markedGame(ws, false);
    const input = join(root, 'records/loops/regress-1-1/content-input-1.md');
    const run = async (argv: string[]): Promise<string> => (await ogw(ws, ['agent', ...argv, '--background'], { cwd: root })).stderr;
    expect(await run(['content', '--game', 'g', '--input', input, '--seed-run', 'regress-1-1:1'])).toContain('--seed-run starts only in a regression state or fix repo of ogw regress, not in g');
    await writeMark(join(root, '.git'), { kind: 'fix', state: 's' });
    expect(await run(['play', '--game', 'g', '--input', input, '--seed-run', 'regress-1-1:1'])).toContain('--seed-run is given only to role content or translation');
    expect(await run(['content', '--game', 'g', '--input', input, '--seed-run', 'regress-1-1'])).toContain('--seed-run takes <records>:<iteration>');
    expect(await run(['content', '--game', 'g', '--input', input, '--seed-run', 'regress:0'])).toContain('--seed-run takes <records>:<iteration>');
    const game = { name: 'g', root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false };
    await changeRuns(game, (runs) => {
      runs.push(newRunState({ name: 'r1', kind: 'loop', branch: 'main', baseCommit: sh(root, 'git', ['rev-parse', 'HEAD']).trim(), iteration: 1 }));
    });
    expect(await run(['content', '--game', 'g', '--input', input, '--seed-run', 'regress-1-1:1'])).toContain('has an open run r1; --seed-run starts outside a run');
  });
});

describe('the regression mark', () => {
  it('keeps ogw loop start and ogw judge calibrate out of a regression state', async () => {
    const ws = makeWorkspace();
    const root = makeGame(ws, 'g', { 'settings.json': { coreVersion: '1.0.0' } });
    await writeMark(join(root, '.git'), { kind: 'state', state: 's' });
    const start = await ogw(ws, ['loop', 'start', 'g', '--command', 'update'], { stdin: 'x\n' });
    expect(start.stderr).toContain('ogw loop start does not run in g: it is a regression state of the regression suite (ogw regress)');
    const game = await ctxOf(ws).game('g');
    await expect(prepareMain(ctxOf(ws), game)).rejects.toThrow('ogw judge calibrate does not run in g: it is a regression state');
  });
});
