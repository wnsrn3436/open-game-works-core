import { chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ogw } from '../../helpers/workspace.ts';
import { commit, currentRun, git, openBuildRun, openLoopRun, read, setRun, setupGame, write, type TestGame } from './helpers.ts';

const mocks = vi.hoisted(() => ({
  runData: vi.fn(),
  syncResources: vi.fn(),
  listInstances: vi.fn(),
  stopInstance: vi.fn(),
  markProposalReleased: vi.fn(),
  agentOutcome: vi.fn(),
  mergeAgentJobs: vi.fn(),
  retryAgentJob: vi.fn(),
  startAgentJob: vi.fn(),
}));

vi.mock('../../../src/commands/data/api.ts', () => ({ runData: mocks.runData }));
vi.mock('../../../src/commands/resource/api.ts', () => ({ syncResources: mocks.syncResources, requestPendingResources: vi.fn() }));
vi.mock('../../../src/commands/instance/api.ts', () => ({ listInstances: mocks.listInstances, stopInstance: mocks.stopInstance, startInstance: vi.fn() }));
vi.mock('../../../src/commands/core/api.ts', () => ({ markProposalReleased: mocks.markProposalReleased }));
vi.mock('../../../src/commands/agent/api.ts', () => ({
  agentOutcome: mocks.agentOutcome,
  mergeAgentJobs: mocks.mergeAgentJobs,
  retryAgentJob: mocks.retryAgentJob,
  startAgentJob: mocks.startAgentJob,
}));

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.runData.mockResolvedValue({ exitCode: 0, lines: [], stderr: '' });
  mocks.syncResources.mockResolvedValue(undefined);
  mocks.listInstances.mockResolvedValue([]);
  mocks.stopInstance.mockResolvedValue(undefined);
  mocks.markProposalReleased.mockResolvedValue('marked');
});

const R = 'records/loops/update-1';

function record(sha: string, gate: boolean, vs: string | null, status = 'done'): string {
  const result = gate ? 'pass' : 'fail';
  const checks = ['regression test', 'static check', 'no blocker', 'full flow'].map((n) => `| ${n} | ${result} | p |`).join('\n');
  const judge = vs === null ? 'none' : `### j\n\n- kind: main\n- status: ${status}\n- vs baseline: ${vs}\n- vs reference: pass`;
  return `## commit\n\n- instance: ${sha}\n- baseline: none\n\n## checks\n\n| check | result | file |\n|---|---|---|\n${checks}\n\n## judge\n\n${judge}\n`;
}

/** A loop run with iterations: 1 passes and is better, 2 is worse, 3 fails the gate. */
async function loopWithRecords(): Promise<{ g: TestGame; c1: string; base: string }> {
  const g = setupGame();
  const run = await openLoopRun(g, { iteration: 3 });
  write(g.root, 'game.txt', 'v1');
  const c1 = commit(g.root, 'iteration 1');
  write(g.root, `${R}/iteration-1.md`, record(c1, true, 'better'));
  write(g.root, 'game.txt', 'v2');
  const c2 = commit(g.root, 'iteration 2');
  write(g.root, `${R}/iteration-2.md`, record(c2, true, 'worse'));
  write(g.root, 'game.txt', 'v3');
  const c3 = commit(g.root, 'iteration 3');
  write(g.root, `${R}/iteration-3.md`, record(c3, false, null));
  commit(g.root, 'records');
  return { g, c1, base: run.baseCommit };
}

describe('ogw loop prepare-merge', () => {
  it('chooses the latest passing, judged, not-worse iteration and makes merge/<run>', async () => {
    const { g, c1 } = await loopWithRecords();
    const out = await ogw(g.ws, ['loop', 'prepare-merge', 'g']);
    expect(out).toMatchObject({ code: 0, stdout: `merge commit: ${c1}\nbranch: merge/update-1\n` });
    expect(git(g.root, 'branch', '--show-current')).toBe('merge/update-1');
    expect(read(g.root, 'game.txt')).toBe('v1');
    expect(existsSync(join(g.root, R, 'iteration-3.md'))).toBe(true);
    expect(git(g.root, 'rev-parse', 'HEAD~1')).toBe(c1);
    expect(mocks.syncResources).toHaveBeenCalledOnce();
    expect(mocks.runData).toHaveBeenCalledOnce();
    expect(((await currentRun(g)).data.loop as { prepareMerge: unknown }).prepareMerge).toEqual({
      commit: c1,
      withSyncedWork: true,
      mainHead: (await currentRun(g)).baseCommit,
      baseCommit: (await currentRun(g)).baseCommit,
      created: true,
    });
  });

  it('skips a latest iteration whose main judge failed for an earlier done one', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    write(g.root, 'game.txt', 'v1');
    const c1 = commit(g.root, 'iteration 1');
    write(g.root, `${R}/iteration-1.md`, record(c1, true, 'better'));
    write(g.root, 'game.txt', 'v2');
    const c2 = commit(g.root, 'iteration 2');
    write(g.root, `${R}/iteration-2.md`, record(c2, true, 'none', 'failed'));
    commit(g.root, 'records');
    expect(await ogw(g.ws, ['loop', 'prepare-merge', 'g'])).toMatchObject({ code: 0, stdout: `merge commit: ${c1}\nbranch: merge/update-1\n` });
    expect(read(g.root, 'game.txt')).toBe('v1');
  });

  it('merges a passed confirmation iteration, else the latest candidate iteration, without the work synced after it', async () => {
    const full = (sha: string, confirms: number | null, blockers: number): string => {
      const checks = ['regression test', 'static check', 'no blocker', 'performance', 'UI quality', 'no placeholder', 'full flow']
        .map((n) => `| ${n} | ${n === 'no placeholder' ? 'fail' : 'pass'} | p |`).join('\n');
      const judges = ['main', 'success', 'success'].map((kind, i) => `### j${String(i)}\n\n- kind: ${kind}\n- vs baseline: better\n- vs reference: pass`).join('\n\n');
      const play = `| feedback | blocker | major | minor | none |\n|---|---|---|---|---|\n| p | ${String(blockers)} | 0 | 0 | 0 |`;
      return `## commit\n\n- instance: ${sha}\n- baseline: none\n- confirms: ${confirms === null ? 'none' : String(confirms)}\n\n## checks\n\n| check | result | file |\n|---|---|---|\n${checks}\n\n## judge\n\n${judges}\n\n## play\n\n${play}\n`;
    };
    for (const passed of [false, true]) {
      const g = setupGame();
      await openLoopRun(g, { iteration: 3 });
      write(g.root, 'game.txt', 'v1');
      const c1 = commit(g.root, 'iteration 1');
      write(g.root, `${R}/iteration-1.md`, full(c1, null, 0));
      write(g.root, 'game.txt', 'v2');
      const c2 = commit(g.root, 'iteration 2 (synced resources)');
      write(g.root, `${R}/iteration-2.md`, full(c2, 1, passed ? 0 : 1));
      write(g.root, `${R}/iteration-3.md`, record(c2, false, null));
      commit(g.root, 'records');
      await setRun(g, (run) => {
        run.data.loop = { verdict: { iteration: 3, reason: 'limit reached', evidence: [] } };
      });
      const chosen = passed ? c2 : c1;
      expect(await ogw(g.ws, ['loop', 'prepare-merge', 'g'])).toMatchObject({ code: 0, stdout: `merge commit: ${chosen}\nbranch: merge/update-1\n` });
      expect(git(g.root, 'rev-parse', 'HEAD~1')).toBe(chosen);
      expect(git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').every((path) => path.startsWith('records/'))).toBe(true);
      expect(read(g.root, 'game.txt')).toBe(passed ? 'v2' : 'v1');
      expect(mocks.syncResources).not.toHaveBeenCalled();
      expect(mocks.runData).not.toHaveBeenCalled();
    }
  });

  it('merges the success iteration, which no other rule picks, without the work synced after it', async () => {
    const { g } = await loopWithRecords();
    // iteration 2 is worse than its baseline: only the success rule chooses it; the last rule would choose iteration 1
    const c2 = git(g.root, 'rev-parse', 'HEAD~2');
    await setRun(g, (run) => {
      run.data.loop = { verdict: { iteration: 2, reason: 'success', evidence: [] } };
    });
    expect(await ogw(g.ws, ['loop', 'prepare-merge', 'g'])).toMatchObject({ code: 0, stdout: `merge commit: ${c2}\nbranch: merge/update-1\n` });
    expect(read(g.root, 'game.txt')).toBe('v2');
    expect(git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').every((path) => path.startsWith('records/'))).toBe(true);
    expect(mocks.syncResources).not.toHaveBeenCalled();
    expect(mocks.runData).not.toHaveBeenCalled();
  });

  it('makes a records-only branch when no iteration qualifies', async () => {
    const g = setupGame();
    const run = await openLoopRun(g, { iteration: 1 });
    write(g.root, 'game.txt', 'changed');
    const c = commit(g.root);
    write(g.root, `${R}/iteration-1.md`, record(c, true, 'worse'));
    write(g.root, `${R}/request.md`, 'req');
    commit(g.root);
    const out = await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--json']);
    expect(JSON.parse(out.stdout)).toEqual({ commit: null, branch: 'merge/update-1' });
    expect(git(g.root, 'rev-parse', 'HEAD~1')).toBe(run.baseCommit);
    expect(existsSync(join(g.root, 'game.txt'))).toBe(false);
    expect(read(g.root, `${R}/request.md`)).toBe('req');
    expect(git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([`${R}/iteration-1.md`, `${R}/request.md`]);
    expect(mocks.runData).not.toHaveBeenCalled();
  });

  it('refuses when main moved and records it', async () => {
    const { g, c1, base } = await loopWithRecords();
    git(g.root, 'checkout', '-q', 'main');
    write(g.root, 'hotfix.txt', 'x');
    const moved = commit(g.root);
    git(g.root, 'checkout', '-q', 'loop/update-1');
    const out = await ogw(g.ws, ['loop', 'prepare-merge', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`main HEAD ${moved} is not the work branch base ${base}`);
    expect(git(g.root, 'branch', '--list', 'merge/*')).toBe('');
    expect(((await currentRun(g)).data.loop as { prepareMerge: unknown }).prepareMerge).toEqual({ commit: c1, withSyncedWork: true, mainHead: moved, baseCommit: base, created: false });
  });

  it('remakes an unmerged branch, refuses a merged one, and checks its arguments', async () => {
    const { g } = await loopWithRecords();
    await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--records-only']);
    git(g.root, 'checkout', '-q', 'loop/update-1');
    const again = await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--records-only']);
    expect(again).toMatchObject({ code: 0, stdout: 'merge/update-1\n' });
    expect(git(g.root, 'rev-list', '--count', 'main..merge/update-1')).toBe('1');
    git(g.root, 'checkout', '-q', 'main');
    git(g.root, 'merge', '-q', '--no-ff', '-m', 'm', 'merge/update-1');
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--records-only'])).stderr).toContain('already merged into main');
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--commit', 'nope'])).stderr).toContain('not a commit: nope');
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--commit', 'x', '--records-only'])).stderr).toContain('usage:');
  });

  it('reads CSV as ogw agent merge does: keeps CRLF and refuses a malformed file', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 1 });
    write(g.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\r\nk1,Hello,,h1,\r\n');
    const chosen = commit(g.root, 'chosen');
    const before = chosen;
    write(g.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\r\nk1,Hello,h1,h1,안녕\r\n');
    const after = commit(g.root, 'agent merge translation');
    write(g.root, `${R}/iteration-1.md`, record(chosen, true, 'better'));
    commit(g.root, 'records');
    await setRun(g, (run) => {
      run.data.loop = { tasks: [], handled: [], merges: [{ job: 't1', role: 'translation', before, after }], verdict: null, prepareMerge: null };
    });
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--commit', chosen])).code).toBe(0);
    expect(read(g.root, 'data/translations/ko.csv')).toBe('key,source,source_hash,current_hash,text\r\nk1,Hello,h1,h1,안녕\r\n');

    const h = setupGame();
    await openLoopRun(h, { iteration: 1 });
    write(h.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\nk1,Hello,,h1,"open\n');
    const bad = commit(h.root, 'chosen');
    write(h.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\nk1,Hello,h1,h1,x\n');
    const fixed = commit(h.root, 'agent merge translation');
    await setRun(h, (run) => {
      run.data.loop = { tasks: [], handled: [], merges: [{ job: 't1', role: 'translation', before: bad, after: fixed }], verdict: null, prepareMerge: null };
    });
    const out = await ogw(h.ws, ['loop', 'prepare-merge', 'g', '--commit', bad]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('invalid CSV: line 2: unclosed quote');
  });

  it('adds the resource and translation work merged after the commit for its keys', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 2 });
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/a,placeholder,\nsprite_animation/run,placeholder,\n');
    write(g.root, 'resource/icon/a.png', 'placeholder');
    write(g.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\nk1,Hello,,h1,\n');
    write(g.root, 'data/translations/en.csv', 'key,source,source_hash,current_hash,text\nk1,Hello,h1,h1,Hello\n');
    write(g.root, 'data/glossary.csv', 'source,id_name,note,source_hash,ko\nSword,[sword],,s1,\n');
    const chosen = commit(g.root, 'chosen');
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/a,placeholder,\nsprite_animation/run,placeholder,\nicon/new,placeholder,\n');
    write(g.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\nk1,Hello!,,h9,\nk2,Bye,,h2,\n');
    commit(g.root, 'content after');
    const before = git(g.root, 'rev-parse', 'HEAD');
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/a,final,MIT\nsprite_animation/run,final,MIT\nicon/new,final,MIT\nsprite_sheet/run,final,MIT\nimage/other/x,final,MIT\n');
    write(g.root, 'resource/icon/a.png', 'final a');
    write(g.root, 'resource/icon/new.png', 'final new');
    write(g.root, 'resource/sprite_sheet/run.png', 'sheet');
    write(g.root, 'resource/sprite_sheet/run.png.import', 'meta');
    const afterResource = commit(g.root, 'agent merge resource');
    write(g.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\nk1,Hello!,h9,h9,"안녕, 하세요"\nk2,Bye,h2,h2,잘가\n');
    write(g.root, 'data/glossary.csv', 'source,id_name,note,source_hash,ko\nSword,[sword],,s1,검\n');
    const afterTranslation = commit(g.root, 'agent merge translation');
    write(g.root, `${R}/iteration-1.md`, record(chosen, true, 'better'));
    commit(g.root, 'records');
    await setRun(g, (run) => {
      run.data.loop = {
        tasks: [],
        handled: [],
        merges: [
          { job: 'old', role: 'resource', before: git(g.root, 'rev-parse', `${chosen}~1`), after: chosen },
          { job: 'r1', role: 'resource', before, after: afterResource },
          { job: 't1', role: 'translation', before: afterResource, after: afterTranslation },
        ],
        verdict: null,
        prepareMerge: null,
      };
    });
    const out = await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--commit', chosen]);
    expect(out).toMatchObject({ code: 0, stdout: 'merge/update-1\n' });
    expect(read(g.root, 'resource/resources.csv')).toBe('key,status,license\nicon/a,final,MIT\nsprite_animation/run,final,MIT\nsprite_sheet/run,final,MIT\n');
    expect(read(g.root, 'resource/icon/a.png')).toBe('final a');
    expect(read(g.root, 'resource/sprite_sheet/run.png.import')).toBe('meta');
    expect(existsSync(join(g.root, 'resource/icon/new.png'))).toBe(false);
    expect(read(g.root, 'data/translations/ko.csv')).toBe('key,source,source_hash,current_hash,text\nk1,Hello,h9,h1,"안녕, 하세요"\n');
    expect(read(g.root, 'data/translations/en.csv')).toBe('key,source,source_hash,current_hash,text\nk1,Hello,h1,h1,Hello\n');
    expect(read(g.root, 'data/glossary.csv')).toBe('source,id_name,note,source_hash,ko\nSword,[sword],,s1,검\n');
    expect(read(g.root, `${R}/iteration-1.md`)).toContain(chosen);
    expect(git(g.root, 'status', '--porcelain')).toBe('');
    expect(git(g.root, 'rev-parse', 'HEAD~1')).toBe(chosen);
  });

  it('remakes a branch that a failed preparation left at the work branch base', async () => {
    const { g, base } = await loopWithRecords();
    write(g.root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    chmodSync(join(g.root, '.git/hooks/pre-commit'), 0o755);
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--records-only'])).code).toBe(1);
    expect(git(g.root, 'rev-parse', 'merge/update-1')).toBe(base);
    rmSync(join(g.root, '.git/hooks/pre-commit'));
    // The failed preparation left the checkout on merge/update-1 with the work branch records staged.
    expect(git(g.root, 'branch', '--show-current')).toBe('merge/update-1');
    expect(git(g.root, 'status', '--porcelain')).not.toBe('');
    const again = await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--records-only']);
    expect(again).toMatchObject({ code: 0, stdout: 'merge/update-1\n' });
    expect(git(g.root, 'rev-parse', 'merge/update-1~1')).toBe(base);
    expect(git(g.root, 'rev-list', '--count', 'main..merge/update-1')).toBe('1');
  });

  it('prepares again after ogw data failed, from what the failed preparation left in the checkout', async () => {
    const { g, c1 } = await loopWithRecords();
    mocks.runData.mockImplementationOnce(() => {
      write(g.root, 'data/generated.bin', 'half');
      return Promise.resolve({ exitCode: 1, lines: [{ text: 'bad row' }], stderr: '' });
    });
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g'])).code).toBe(1);
    expect(git(g.root, 'branch', '--show-current')).toBe('merge/update-1');
    const again = await ogw(g.ws, ['loop', 'prepare-merge', 'g']);
    expect(again).toMatchObject({ code: 0, stdout: `merge commit: ${c1}\nbranch: merge/update-1\n` });
    expect(git(g.root, 'rev-parse', 'HEAD~1')).toBe(c1);
    expect(git(g.root, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual([`${R}/iteration-1.md`, `${R}/iteration-2.md`, `${R}/iteration-3.md`]);
    expect(git(g.root, 'status', '--porcelain')).toBe('');
    expect(existsSync(join(g.root, 'data/generated.bin'))).toBe(false);
  });

  it('records why preparation failed when main HEAD is the work branch base', async () => {
    const { g, c1, base } = await loopWithRecords();
    const during: unknown[] = [];
    mocks.runData.mockImplementation(async () => {
      during.push(((await currentRun(g)).data.loop as { prepareMerge: unknown }).prepareMerge);
      return { exitCode: 1, lines: [{ text: 'bad row' }], stderr: '' };
    });
    const out = await ogw(g.ws, ['loop', 'prepare-merge', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw data failed on merge/update-1:\nbad row');
    expect(during).toEqual([{ commit: c1, withSyncedWork: true, mainHead: base, baseCommit: base, created: false, failed: 'ogw loop prepare-merge did not finish' }]);
    expect(((await currentRun(g)).data.loop as { prepareMerge: unknown }).prepareMerge).toEqual({
      commit: c1,
      withSyncedWork: true,
      mainHead: base,
      baseCommit: base,
      created: false,
      failed: 'ogw data failed on merge/update-1:\nbad row',
    });
  });

  it('adds only merges made at or after the commit, and removes rows and files they removed', async () => {
    const g = setupGame();
    await openLoopRun(g, { iteration: 1 });
    const start = git(g.root, 'rev-parse', 'HEAD');
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/a,placeholder,\nicon/b,placeholder,\nrig_animation_2d/hero,final,MIT\nimage/hero/arm,final,MIT\nimage/hero/leg,final,MIT\n');
    write(g.root, 'resource/icon/a.png', 'placeholder');
    write(g.root, 'resource/icon/b.png', 'placeholder b');
    write(g.root, 'resource/rig_animation_2d/hero.json', 'rig');
    write(g.root, 'resource/image/hero/arm.png', 'arm');
    write(g.root, 'resource/image/hero/leg.png', 'leg');
    write(g.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\nk1,Hello,,h1,\n');
    const chosen = commit(g.root, 'chosen');
    git(g.root, 'checkout', '-q', '-b', 'side', start);
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/b,final,SIDE\n');
    write(g.root, 'resource/icon/b.png', 'side b');
    write(g.root, 'data/translations/ko.csv', 'key,source,source_hash,current_hash,text\nk1,Hello,h1,h1,side\n');
    const side = commit(g.root, 'side');
    git(g.root, 'checkout', '-q', 'loop/update-1');
    write(g.root, 'resource/resources.csv', 'key,status,license\nicon/a,final,MIT\nicon/b,placeholder,\nrig_animation_2d/hero,final,MIT\nimage/hero/leg,final,MIT\nimage/hero/hand,final,MIT\n');
    write(g.root, 'resource/icon/a.png', 'final a');
    rmSync(join(g.root, 'resource/image/hero/arm.png'));
    write(g.root, 'resource/image/hero/hand.png', 'hand');
    const afterResource = commit(g.root, 'agent merge resource');
    write(g.root, `${R}/iteration-1.md`, record(chosen, true, 'better'));
    commit(g.root, 'records');
    await setRun(g, (run) => {
      run.data.loop = {
        tasks: [],
        handled: [],
        merges: [
          { job: 'side-r', role: 'resource', before: start, after: side },
          { job: 'side-t', role: 'translation', before: start, after: side },
          { job: 'r1', role: 'resource', before: chosen, after: afterResource },
        ],
        verdict: null,
        prepareMerge: null,
      };
    });
    const out = await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--commit', chosen]);
    expect(out).toMatchObject({ code: 0, stdout: 'merge/update-1\n' });
    expect(read(g.root, 'resource/resources.csv')).toBe(
      'key,status,license\nicon/a,final,MIT\nicon/b,placeholder,\nrig_animation_2d/hero,final,MIT\nimage/hero/leg,final,MIT\nimage/hero/hand,final,MIT\n',
    );
    expect(read(g.root, 'resource/icon/a.png')).toBe('final a');
    expect(read(g.root, 'resource/icon/b.png')).toBe('placeholder b');
    expect(existsSync(join(g.root, 'resource/image/hero/arm.png'))).toBe(false);
    expect(read(g.root, 'resource/image/hero/leg.png')).toBe('leg');
    expect(read(g.root, 'resource/image/hero/hand.png')).toBe('hand');
    expect(read(g.root, 'data/translations/ko.csv')).toBe('key,source,source_hash,current_hash,text\nk1,Hello,,h1,\n');
    expect(git(g.root, 'status', '--porcelain')).toBe('');
    expect(git(g.root, 'rev-parse', 'HEAD~1')).toBe(chosen);
  });

  it('fails when ogw data fails', async () => {
    const { g, c1 } = await loopWithRecords();
    mocks.runData.mockResolvedValue({ exitCode: 1, lines: [{ text: 'a.csv:1:1 ERROR x y' }], stderr: 'boom' });
    const out = await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--commit', c1]);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw data failed on merge/update-1:\na.csv:1:1 ERROR x yboom');
  });
});

describe('ogw loop merge', () => {
  it('merges merge/<run> into main with a merge commit', async () => {
    const { g } = await loopWithRecords();
    expect((await ogw(g.ws, ['loop', 'merge', 'g'])).stderr).toContain('branch merge/update-1 does not exist');
    await ogw(g.ws, ['loop', 'prepare-merge', 'g']);
    const tip = git(g.root, 'rev-parse', 'merge/update-1');
    const out = await ogw(g.ws, ['loop', 'merge', 'g']);
    expect(out.code).toBe(0);
    const head = git(g.root, 'rev-parse', 'main');
    expect(out.stdout).toBe(`${head}\n`);
    expect(git(g.root, 'branch', '--show-current')).toBe('main');
    expect(git(g.root, 'rev-parse', `${head}^2`)).toBe(tip);
    expect(read(g.root, 'game.txt')).toBe('v1');
  });

  it('refuses when main moved', async () => {
    const { g, base } = await loopWithRecords();
    await ogw(g.ws, ['loop', 'prepare-merge', 'g']);
    git(g.root, 'checkout', '-q', 'main');
    write(g.root, 'hotfix.txt', 'x');
    const moved = commit(g.root);
    const out = await ogw(g.ws, ['loop', 'merge', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain(`main HEAD ${moved} is not the work branch base ${base}; not merged`);
    expect(git(g.root, 'rev-parse', 'main')).toBe(moved);
  });

  it('refuses a branch that a failed preparation left at the work branch base', async () => {
    const { g, base } = await loopWithRecords();
    write(g.root, '.git/hooks/pre-commit', '#!/bin/sh\nexit 1\n');
    chmodSync(join(g.root, '.git/hooks/pre-commit'), 0o755);
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--records-only'])).code).toBe(1);
    rmSync(join(g.root, '.git/hooks/pre-commit'));
    git(g.root, 'reset', '-q', '--hard');
    expect(git(g.root, 'rev-parse', 'merge/update-1')).toBe(base);
    const out = await ogw(g.ws, ['loop', 'merge', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop prepare-merge failed: ');
    expect(git(g.root, 'rev-parse', 'main')).toBe(base);
    expect(git(g.root, 'branch', '--show-current')).toBe('merge/update-1');
    // a recorded success with the branch moved back to the base
    git(g.root, 'checkout', '-q', 'loop/update-1');
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--records-only'])).code).toBe(0);
    git(g.root, 'checkout', '-q', 'loop/update-1');
    git(g.root, 'branch', '-f', 'merge/update-1', base);
    const empty = await ogw(g.ws, ['loop', 'merge', 'g']);
    expect(empty.code).toBe(1);
    expect(empty.stderr).toContain(`branch merge/update-1 has no commit beyond the work branch base ${base}; not merged`);
    expect(git(g.root, 'rev-parse', 'main')).toBe(base);
  });

  it('refuses when the recorded preparation failed, even with a branch past the base', async () => {
    const { g, c1, base } = await loopWithRecords();
    mocks.runData.mockResolvedValue({ exitCode: 1, lines: [{ text: 'bad row' }], stderr: '' });
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g'])).code).toBe(1);
    git(g.root, 'reset', '-q', '--hard');
    // The failed preparation left merge/update-1 at the chosen iteration commit.
    expect(git(g.root, 'rev-parse', 'merge/update-1')).toBe(c1);
    const out = await ogw(g.ws, ['loop', 'merge', 'g']);
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('ogw loop prepare-merge failed: ogw data failed on merge/update-1:\nbad row; not merged');
    expect(git(g.root, 'rev-parse', 'main')).toBe(base);
  });

  it('merges after a failed preparation is made again with --commit or --records-only', async () => {
    const { g, c1, base } = await loopWithRecords();
    mocks.runData.mockResolvedValueOnce({ exitCode: 1, lines: [{ text: 'bad row' }], stderr: '' });
    expect((await ogw(g.ws, ['loop', 'prepare-merge', 'g'])).code).toBe(1);
    git(g.root, 'reset', '-q', '--hard');
    const again = await ogw(g.ws, ['loop', 'prepare-merge', 'g', '--commit', c1]);
    expect(again).toMatchObject({ code: 0, stdout: 'merge/update-1\n' });
    expect(((await currentRun(g)).data.loop as { prepareMerge: unknown }).prepareMerge).toEqual({ commit: c1, withSyncedWork: true, mainHead: base, baseCommit: base, created: true });
    const out = await ogw(g.ws, ['loop', 'merge', 'g']);
    expect(out.code).toBe(0);
    expect(git(g.root, 'rev-parse', 'main^2~1')).toBe(c1);

    const other = await loopWithRecords();
    mocks.runData.mockResolvedValueOnce({ exitCode: 1, lines: [{ text: 'bad row' }], stderr: '' });
    expect((await ogw(other.g.ws, ['loop', 'prepare-merge', 'g'])).code).toBe(1);
    git(other.g.root, 'reset', '-q', '--hard');
    expect((await ogw(other.g.ws, ['loop', 'prepare-merge', 'g', '--records-only'])).code).toBe(0);
    expect(((await currentRun(other.g)).data.loop as { prepareMerge: unknown }).prepareMerge).toEqual({
      commit: null,
      withSyncedWork: false,
      mainHead: other.base,
      baseCommit: other.base,
      created: true,
    });
    expect((await ogw(other.g.ws, ['loop', 'merge', 'g'])).code).toBe(0);
    expect(git(other.g.root, 'rev-parse', 'main^2~1')).toBe(other.base);
  });

  it('runs only in a loop run', async () => {
    const g = setupGame();
    expect((await ogw(g.ws, ['loop', 'merge', 'g'])).stderr).toContain('no open run for game g');
    const run = await openBuildRun(g);
    write(g.root, 'hardened.txt', 'x');
    commit(g.root, 'hardening');
    git(g.root, 'branch', 'merge/build-stg-0.2.0');
    const out = await ogw(g.ws, ['loop', 'merge', 'g']);
    expect(out.code).not.toBe(0);
    expect(out.stderr).toContain('runs only in a loop run');
    expect(git(g.root, 'rev-parse', 'main')).toBe(run.baseCommit);
    expect(git(g.root, 'branch', '--show-current')).toBe('build/stg-0.2.0');
  });
});
