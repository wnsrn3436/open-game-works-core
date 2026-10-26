import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli } from '../agent/helpers.ts';
import { finding, reviewFile } from './helpers.ts';
import { d1, ids, reviewer, seedList } from './debt-fixture.ts';

describe('ogw review spec: scope and lists', () => {
  /** Starts a spec review and waits for it; returns the job's input text and the wait output. */
  async function specReview(ws: TestWorkspace, args: string[], env: NodeJS.ProcessEnv): Promise<{ input: string; waited: Awaited<ReturnType<typeof ogw>> }> {
    const started = await ogw(ws, ['review', 'spec', 'core', 'routing', ...args], { env });
    expect(started.stderr).toBe('');
    const id = started.stdout.trim();
    const input = readFileSync(((await readJob(id, ws.env)).meta as { input: string }).input, 'utf8');
    return { input, waited: await ogw(ws, ['agent', 'wait', id, '--timeout', '60000']) };
  }

  it('needs one of --since, --full, --debt, gives the spec diff since --since, and refuses a spec that did not change', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([]), 2: reviewFile([]), 3: reviewFile([]) });
    for (const args of [[], ['--full', '--since', 'HEAD'], ['--full', '--debt']]) {
      expect((await ogw(ws, ['review', 'spec', 'core', 'routing', ...args], { env })).stderr).toContain('usage: ogw review spec core <module> <--since <commit>|--full|--debt>');
    }
    expect((await ogw(ws, ['review', 'spec', 'core', 'routing', '--debt'], { env })).stderr).toContain('--debt of routing: its spec debt list has no item');
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    expect((await ogw(ws, ['review', 'spec', 'core', 'routing', '--since', head], { env })).stderr).toContain('the spec skills/server-core/modules/routing.md did not change since');
    const spec = join(ws.harness, 'skills', 'server-core', 'modules', 'routing.md');
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n- changed rule\n`);
    const changed = await specReview(ws, ['--since', head], env);
    const diff = /## spec changes\n\n(\S+)\n/.exec(changed.input)?.[1] ?? '';
    expect(readFileSync(diff, 'utf8')).toContain('+- changed rule');
    const full = await specReview(ws, ['--full'], env);
    expect(full.input).toContain('## spec changes\n\nnone\n');
    // a spec not in the --since commit is new: the whole spec, which pays its spec debt
    seedList(ws.coreImpl, 'debt', 'spec-routing.json', { target: 'spec routing', nextId: 2, items: [{ ...d1, location: 'skills/server-core/modules/routing.md:9', foundBy: 'spec routing' }] });
    rmSync(spec);
    const without = commitAll(ws.harness, 'no routing spec');
    sh(ws.harness, 'git', ['checkout', '--quiet', head, '--', 'skills/server-core/modules/routing.md']);
    expect((await specReview(ws, ['--since', without], env)).input).toContain('## spec changes\n\nnone\n\n## debt\n\n- D1: skills/server-core/modules/routing.md:9: medium a slow loop\n');
  });

  it('writes out of scope items to the spec lists at agent wait once, pays the debt only with --full or --debt, and gives must-fix items to every spec review', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, {
      1: reviewFile([], [], ['- skills/server-core/modules/storage.md:4: medium two names for one error', '- skills/server-core/modules/routing.md:9: medium an unused key', '- skills/server-core/modules/routing.md:12: high two orders']),
      2: reviewFile([], [], [], [], ['| M1 | open | R1-1 | still |']).replace('## findings\n\nnone', `## findings\n\n| id | aspect | severity | location | evidence | fix | spec change | confidence |\n|---|---|---|---|---|---|---|---|\n${finding('R1-1', 'yes')}`),
      3: reviewFile([], [], [], ['| D1 | fixed | none | gone |'], ['| M1 | fixed | none | gone |']),
    });
    const first = await specReview(ws, ['--full'], env);
    expect(first.waited.code).toBe(0);
    expect(first.waited.stdout).toContain('review debt added: spec storage D1: skills/server-core/modules/storage.md:4: medium two names for one error\n');
    expect(first.waited.stdout).toContain('review debt added: spec routing D1: skills/server-core/modules/routing.md:9: medium an unused key\n');
    expect(first.waited.stdout).toContain('review must fix added: spec routing M1: skills/server-core/modules/routing.md:12: high two orders\n');
    expect(sh(ws.coreImpl, 'git', ['log', '-1', '--format=%s', 'main']).trim()).toBe('ogw: review lists of spec routing');
    // a review of a change gives the must-fix items, not the debt; with no change the must-fix item lets it start
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    const confirm = await specReview(ws, ['--since', head], env);
    expect(readFileSync(/## spec changes\n\n(\S+)\n/.exec(confirm.input)?.[1] ?? '', 'utf8')).toBe('');
    expect(confirm.input).toContain('## debt\n\nnone\n\n## must fix\n\n- M1: skills/server-core/modules/routing.md:12: high two orders\n');
    expect(confirm.waited.code).toBe(0);
    // --debt: an empty diff, the debt items and the must-fix items
    const paying = await specReview(ws, ['--debt'], env);
    expect(readFileSync(/## spec changes\n\n(\S+)\n/.exec(paying.input)?.[1] ?? '', 'utf8')).toBe('');
    expect(paying.input).toContain('## debt\n\n- D1: skills/server-core/modules/routing.md:9: medium an unused key\n\n## must fix\n\n- M1: ');
    expect(paying.waited.stdout).toContain('review debt removed: spec routing D1\nreview must fix removed: spec routing M1\n');
    expect(ids(ws.coreImpl, 'debt', 'spec-routing.json')).toEqual([]);
    expect(ids(ws.coreImpl, 'debt', 'spec-storage.json')).toEqual(['D1']);
    expect((await ogw(ws, ['review', 'spec', 'core', 'routing', '--since', head], { env })).stderr).toContain('did not change since');
  });

  it('keeps a location in the spec review agent\'s worktree or the harness as a harness path, in the lists of the module whose spec holds it', async () => {
    const ws = makeWorkspace();
    const file = reviewFile([], [], ['- CWD/skills/server-core/modules/storage.md:9: medium two names']);
    const { waited } = await specReview(ws, ['--full'], fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(file)}.replace('CWD', process.cwd()));`).env);
    expect(waited.stdout).toContain('review debt added: spec storage D1: skills/server-core/modules/storage.md:9: medium two names\n');
    const harnessFile = reviewFile([], [], [`- ${join(ws.harness, 'skills/server-core/modules/mailbox.md')}:3: medium an unused key`]);
    const second = await specReview(ws, ['--full'], fakeAgentCli(ws, `fs.writeFileSync(output, ${JSON.stringify(harnessFile)});`).env);
    expect(second.waited.stdout).toContain('review debt added: spec mailbox D1: skills/server-core/modules/mailbox.md:3: medium an unused key\n');
  });

  it('writes once per job: a second agent wait prints the same lines and changes nothing', async () => {
    const ws = makeWorkspace();
    const env = reviewer(ws, { 1: reviewFile([], [], ['- skills/server-core/modules/routing.md:9: medium an unused key']), 2: reviewFile([], [], [], ['| D1 | fixed | none | gone |']) });
    const id = (await ogw(ws, ['review', 'spec', 'core', 'routing', '--full'], { env })).stdout.trim();
    const first = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000']);
    expect(first.stdout).toContain('review debt added: spec routing D1');
    await specReview(ws, ['--full'], env);
    expect(ids(ws.coreImpl, 'debt', 'spec-routing.json')).toEqual([]);
    const again = await ogw(ws, ['agent', 'wait', id, '--timeout', '60000']);
    expect(again.stdout).toBe(first.stdout);
    expect(ids(ws.coreImpl, 'debt', 'spec-routing.json')).toEqual([]);
  });

  it('fails at agent wait and writes nothing for a review file not in the form, with a low finding in a review of the changes, or not answering the items', async () => {
    const ws = makeWorkspace();
    const lowSpec = '| R1-1 | `spec` | low | skills/server-core/modules/routing.md:3 | two words | one | yes | 90 |';
    const env = reviewer(ws, {
      1: '## findings\n\nnone\n',
      2: reviewFile([lowSpec], [], ['- skills/server-core/modules/routing.md:9: medium x']),
      3: reviewFile([lowSpec], [], ['- skills/server-core/modules/routing.md:9: medium x']),
      4: reviewFile([]),
    });
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    const broken = await specReview(ws, ['--full'], env);
    expect(broken.waited.code).toBe(1);
    expect(broken.waited.stdout).toContain(': not in the review file format');
    const spec = join(ws.harness, 'skills', 'server-core', 'modules', 'routing.md');
    const head = sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n- changed rule\n`);
    const since = await specReview(ws, ['--since', head], env);
    expect(since.waited.code).toBe(1);
    expect(since.waited.stdout).toContain(': not in the review file format');
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim()).toBe(before);
    // a review of the whole spec takes it
    const full = await specReview(ws, ['--full'], env);
    expect(full.waited.code).toBe(0);
    expect(full.waited.stdout).toContain('review debt added: spec routing D1');
    const after = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    const unanswered = await specReview(ws, ['--full'], env);
    expect(unanswered.waited.code).toBe(1);
    expect(unanswered.waited.stdout).toContain('## debt rows none do not answer the debt items D1');
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim()).toBe(after);
  });
});
