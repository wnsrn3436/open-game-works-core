import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testAtHead, withCoreMain } from '../../../src/commands/core/lib/main-checkout.ts';
import { addTestRecord } from '../../../src/commands/core/lib/test-records.ts';
import { readJob } from '../../../src/lib/jobs.ts';
import { ogw, commitAll, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeAgentCli, gameWithRun, runAgent } from './helpers.ts';

const data = vi.hoisted(() => ({ exitCode: 0, calls: [] as string[], write: null as ((root: string) => void) | null }));
vi.mock('../../../src/commands/data/api.ts', () => ({
  runData: (_ctx: unknown, game: { root: string }) => {
    data.calls.push(game.root);
    data.write?.(game.root);
    return Promise.resolve({ exitCode: data.exitCode, lines: data.exitCode === 0 ? [] : [{ level: 'ERROR', code: 'x', where: 'w', message: 'm', text: 'ERROR x bad row' }], stderr: '' });
  },
}));

/**
 * The `ogw code check core` type check of `ogw agent merge`: `fake` gives the failure lines of a commit (`agent/<id>`
 * for a branch, a commit id for main); with `real` the check runs. `calls` lists the commits checked.
 */
type FakeTypeCheck = (commit: string) => { failures: string[]; complete: boolean; stops?: { part: 'TypeScript' | 'engine'; reason: string }[] };
const typeCheck = vi.hoisted(() => {
  const pass: FakeTypeCheck = () => ({ failures: [], complete: true });
  return { real: false, fake: pass, calls: [] as string[] };
});
vi.mock('../../../src/commands/code/api.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/commands/code/api.ts')>();
  return {
    ...actual,
    runCoreTypeCheck: (ctx: Parameters<typeof actual.runCoreTypeCheck>[0], commit: string, root: string) => {
      typeCheck.calls.push(commit);
      return typeCheck.real ? actual.runCoreTypeCheck(ctx, commit, root) : Promise.resolve({ stops: [], ...typeCheck.fake(commit) });
    },
  };
});

beforeEach(() => {
  typeCheck.real = false;
  typeCheck.fake = () => ({ failures: [], complete: true });
  typeCheck.calls = [];
  data.exitCode = 0;
  data.calls = [];
  data.write = null;
});

const RESOURCES = 'key,status\nhero,placeholder\nsword,placeholder\n';

/** A resource job whose agent changes `hero` and adds an image, then commits. */
async function resourceJob(ws: TestWorkspace, root: string, extra = ''): Promise<string> {
  const fake = fakeAgentCli(
    ws,
    [
      "fs.writeFileSync('resource/resources.csv', 'key,status\\nhero,final\\nsword,placeholder\\n');",
      "fs.mkdirSync('resource/2d', { recursive: true }); fs.writeFileSync('resource/2d/hero.png', 'img');",
      extra,
      "execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'hero']);",
      "fs.writeFileSync(output, 'done');",
    ].join('\n'),
  );
  const { id, waited } = await runAgent(ws, ['resource', '--game', 'g', '--input', join(root, 'records/loops/r1/resource-requests/hero.md')], fake.env, root);
  expect(waited.code).toBe(0);
  return id;
}

async function gameForMerge(ws: TestWorkspace): Promise<string> {
  const { root } = await gameWithRun(ws, { 'resource/resources.csv': RESOURCES, 'records/loops/r1/resource-requests/hero.md': '## keys\n' });
  return root;
}

describe('ogw agent merge: game worktrees', () => {
  it('merges resources.csv by row with the branch changes, runs ogw data, and removes the worktree', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    writeFileSync(join(root, 'resource/resources.csv'), 'key,status\nhero,placeholder\nsword,placeholder\nshield,placeholder\n');
    commitAll(root, 'branch adds shield');
    writeFileSync(join(root, 'untracked-note.md'), 'keep me');
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
    expect(readFileSync(join(root, 'resource/resources.csv'), 'utf8')).toBe('key,status\nhero,final\nsword,placeholder\nshield,placeholder\n');
    expect(readFileSync(join(root, 'resource/2d/hero.png'), 'utf8')).toBe('img');
    expect(sh(root, 'git', ['log', '-1', '--format=%s']).trim()).toBe(`ogw agent merge ${id}`);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('?? untracked-note.md\n');
    expect(data.calls).toEqual([root]);
    expect(existsSync(join(ws.worktrees, 'g', `agent-${id}`))).toBe(false);
    expect(sh(root, 'git', ['branch', '--list', `agent/${id}`])).toBe('');
    expect((await readJob(id, ws.env)).meta.merged).toBe(true);
    const again = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(again).toMatchObject({ code: 1, stdout: `not merged ${id}: already merged: the job was merged before\n` });
  });

  it('commits the files ogw data changes and creates with the merge', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, {
      'resource/resources.csv': RESOURCES,
      'records/loops/r1/resource-requests/hero.md': '## keys\n',
      'data/generated/ids.txt': 'old\n',
    });
    const id = await resourceJob(ws, root);
    writeFileSync(join(root, 'untracked-note.md'), 'keep me');
    data.write = (dir) => {
      writeFileSync(join(dir, 'data/generated/ids.txt'), 'new\n');
      writeFileSync(join(dir, 'data/generated/built.bin'), 'bin');
    };
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
    expect(sh(root, 'git', ['rev-list', '--parents', '-1', 'HEAD']).trim().split(' ')).toHaveLength(3);
    const files = sh(root, 'git', ['diff', '--name-only', 'HEAD^1', 'HEAD']).split('\n').filter((line) => line !== '');
    expect(files).toEqual(expect.arrayContaining(['data/generated/ids.txt', 'data/generated/built.bin', 'resource/resources.csv', 'resource/2d/hero.png']));
    expect(sh(root, 'git', ['log', '-1', '--format=%s']).trim()).toBe(`ogw agent merge ${id}`);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('?? untracked-note.md\n');
  });

  it('does not merge when git refuses to start the merge, and keeps the worktree and branch', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    mkdirSync(join(root, 'resource/2d'), { recursive: true });
    writeFileSync(join(root, 'resource/2d/hero.png'), 'mine');
    const before = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    const result = JSON.parse(run.stdout) as { merged: string[]; failed: { id: string; reason: string; detail: string }[] };
    expect(result.merged).toEqual([]);
    expect(result.failed).toMatchObject([{ id, reason: 'conflict' }]);
    expect(result.failed[0]?.detail).toContain('untracked working tree files would be overwritten');
    expect(data.calls).toEqual([]);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(readFileSync(join(root, 'resource/resources.csv'), 'utf8')).toBe(RESOURCES);
    expect(readFileSync(join(root, 'resource/2d/hero.png'), 'utf8')).toBe('mine');
    expect(sh(root, 'git', ['status', '--porcelain', '--untracked-files=all'])).toBe('?? resource/2d/hero.png\n');
    expect(existsSync(join(ws.worktrees, 'g', `agent-${id}`))).toBe(true);
    expect(sh(root, 'git', ['branch', '--list', `agent/${id}`])).toContain(`agent/${id}`);
    expect((await readJob(id, ws.env)).meta.merged).toBe(false);
  });

  it('keeps the worktree and changes nothing on a row conflict', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    writeFileSync(join(root, 'resource/resources.csv'), 'key,status\nhero,other\nsword,placeholder\n');
    const before = commitAll(root, 'branch changes hero');
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    expect(JSON.parse(run.stdout)).toEqual({ merged: [], failed: [{ id, reason: 'conflict', detail: 'resource/resources.csv: key hero changed on both sides' }] });
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
    expect(existsSync(join(ws.worktrees, 'g', `agent-${id}`))).toBe(true);
    expect((await readJob(id, ws.env)).meta.merged).toBe(false);
  });

  it('does not merge a sub-agent file that is not CSV, with the reason of an ogw data failure', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root, "fs.writeFileSync('resource/resources.csv', 'key,status\\nhero,\"final\\n');");
    writeFileSync(join(root, 'resource/resources.csv'), 'key,status\nhero,placeholder\nsword,other\n');
    const before = commitAll(root, 'branch changes sword');
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    const failed = (JSON.parse(run.stdout) as { failed: { id: string; reason: string; detail: string }[] }).failed;
    expect(failed).toEqual([{ id, reason: 'data', detail: expect.stringMatching(/^resource\/resources\.csv: invalid CSV/) as string }]);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('does not merge a sub-agent resources.csv without the key column when the branch did not change that file', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root, "fs.writeFileSync('resource/resources.csv', 'name,status\\nhero,final\\n');");
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as { failed: { reason: string; detail: string }[] }).failed).toEqual([{ id, reason: 'data', detail: expect.stringContaining('resource/resources.csv') as string }]);
  });

  it('does not merge a sub-agent file that is not CSV when the branch did not change that file', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root, "fs.writeFileSync('resource/resources.csv', 'key,status\\nhero,\"final\\n');");
    const before = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as { failed: { reason: string }[] }).failed.map((f) => f.reason)).toEqual(['data']);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
  });

  it('is a conflict when another file conflicts in git', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root, "fs.writeFileSync('settings.json', '{\"a\": 1}\\n');");
    writeFileSync(join(root, 'settings.json'), '{"a": 2}\n');
    commitAll(root, 'branch settings');
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run.stdout).toBe(`not merged ${id}: conflict: settings.json\n`);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('does not merge when ogw data fails, and removes what the merge left', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    const before = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    data.exitCode = 1;
    data.write = (dir) => {
      writeFileSync(join(dir, 'data-built.bin'), 'bin');
    };
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run.stdout).toBe(`not merged ${id}: data: ERROR x bad row\n`);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(existsSync(join(root, 'resource/2d/hero.png'))).toBe(false);
    expect(existsSync(join(root, 'data-built.bin'))).toBe(false);
    expect(sh(root, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('refuses a checkout with uncommitted changes or on another branch', async () => {
    const ws = makeWorkspace();
    const root = await gameForMerge(ws);
    const id = await resourceJob(ws, root);
    writeFileSync(join(root, 'settings.json'), '{"dirty": true}\n');
    expect((await ogw(ws, ['agent', 'merge', id], { cwd: root })).stdout).toContain('uncommitted changes');
    sh(root, 'git', ['checkout', '--quiet', '--', 'settings.json']);
    sh(root, 'git', ['checkout', '--quiet', '-b', 'other']);
    expect((await ogw(ws, ['agent', 'merge', id], { cwd: root })).stdout).toContain(`is not on loop/r1`);
  });

  it('merges translations and the glossary by their rules', async () => {
    const ws = makeWorkspace();
    const head = 'key,source,source_hash,current_hash,text\n';
    const { root } = await gameWithRun(ws, {
      'records/loops/r1/translation-input-ko-1.md': 'ko',
      'data/translations/ko.csv': `${head}a,A,,h,\nb,B,,h,\n`,
      'data/glossary.csv': 'source,id_name,note,source_hash,ko\nSword,[sword],,s,\n',
    });
    const fake = fakeAgentCli(
      ws,
      [
        `fs.writeFileSync('data/translations/ko.csv', ${JSON.stringify(`${head}a,A,h,h,에이\nb,B,h,h,비\n`)});`,
        "fs.writeFileSync('data/glossary.csv', 'source,id_name,note,source_hash,ko\\nSword,[sword],,s,검\\n');",
        "execFileSync('git', ['commit', '-qam', 'ko']); fs.writeFileSync(output, 'ok');",
      ].join('\n'),
    );
    const { id } = await runAgent(ws, ['translation', '--game', 'g', '--input', join(root, 'records/loops/r1/translation-input-ko-1.md')], fake.env, root);
    writeFileSync(join(root, 'data/translations/ko.csv'), `${head}a,A2,,h2,\nc,C,,h,\n`);
    writeFileSync(join(root, 'data/glossary.csv'), 'source,id_name,note,source_hash,ko\nSword,[sword],noted,s,\n');
    commitAll(root, 'branch source change');
    const run = await ogw(ws, ['agent', 'merge', id], { cwd: root });
    expect(run.code).toBe(0);
    expect(readFileSync(join(root, 'data/translations/ko.csv'), 'utf8')).toBe(`${head}a,A2,h,h2,에이\nc,C,,h,\n`);
    expect(readFileSync(join(root, 'data/glossary.csv'), 'utf8')).toBe('source,id_name,note,source_hash,ko\nSword,[sword],noted,s,검\n');
  });

  it('does not merge a translation file that is not UTF-8, with the reason of an ogw data failure', async () => {
    const ws = makeWorkspace();
    const head = 'key,source,source_hash,current_hash,text\n';
    const { root } = await gameWithRun(ws, { 'records/loops/r1/translation-input-ko-1.md': 'ko', 'data/translations/ko.csv': `${head}a,A,,h,\n` });
    // CP949 bytes of the text cell, which a lossy decode would have turned into U+FFFD and merged
    const fake = fakeAgentCli(
      ws,
      [
        `fs.writeFileSync('data/translations/ko.csv', Buffer.concat([Buffer.from(${JSON.stringify(`${head}a,A,h,h,`)}), Buffer.from([0xbe, 0xc8, 0x0a])]));`,
        "execFileSync('git', ['commit', '-qam', 'ko']); fs.writeFileSync(output, 'ok');",
      ].join('\n'),
    );
    const { id } = await runAgent(ws, ['translation', '--game', 'g', '--input', join(root, 'records/loops/r1/translation-input-ko-1.md')], fake.env, root);
    const before = sh(root, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['agent', 'merge', id, '--json'], { cwd: root });
    expect(run.code).toBe(1);
    expect((JSON.parse(run.stdout) as { failed: unknown[] }).failed).toEqual([{ id, reason: 'data', detail: 'data/translations/ko.csv: not UTF-8' }]);
    expect(sh(root, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(readFileSync(join(root, 'data/translations/ko.csv'), 'utf8')).toBe(`${head}a,A,,h,\n`);
  });

  it('reports unknown and running jobs', async () => {
    const ws = makeWorkspace();
    const run = await ogw(ws, ['agent', 'merge', 'nojob1']);
    expect(run).toMatchObject({ code: 1, stdout: 'not merged nojob1: error: job not found: nojob1\n' });
    expect((await ogw(ws, ['agent', 'merge'])).stderr).toContain('usage: ogw agent merge');
  });
});

describe('ogw agent merge: core worktrees', () => {
  function coreSpec(ws: TestWorkspace, specs: Record<string, string[]>): void {
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    for (const [name, dependencies] of Object.entries(specs)) {
      writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, dependencies }));
    }
    commitAll(ws.coreImpl, 'spec');
  }

  const PASSED = { command: 'ogw core test server', startedAt: 1, exitCode: 0, summary: { tests: 2, passed: 2 } };

  async function coreJob(ws: TestWorkspace, module: string, runs: unknown[] = [PASSED], file = `server/${module}.ts`): Promise<string> {
    writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
    const fake = fakeAgentCli(
      ws,
      `fs.mkdirSync(${JSON.stringify(file.slice(0, file.lastIndexOf('/')))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(file.endsWith('.json') ? JSON.stringify({ name: module, dependencies: ['routing'] }) : 'x')}); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: ${JSON.stringify(runs)} }));`,
    );
    const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
    expect(waited.code).toBe(0);
    return id;
  }

  /** A fake agent CLI line that writes `text` to `file` of its worktree. */
  function writeScript(file: string, text: string): string {
    return `fs.mkdirSync(${JSON.stringify(dirname(file))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, ${JSON.stringify(text)});`;
  }

  /** A core job for `module` whose agent runs `change`, commits, runs `after` and leaves a passing core test run log. */
  async function scriptJob(ws: TestWorkspace, module: string, change: string, after = ''): Promise<string> {
    writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
    const fake = fakeAgentCli(ws, `${change} execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); ${after} fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
    const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
    expect(waited.code).toBe(0);
    return id;
  }

  it('merges core jobs into main in dependency order with git merge', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { storage: ['routing'], routing: [], auth: ['storage'] });
    const auth = await coreJob(ws, 'auth');
    const routing = await coreJob(ws, 'routing');
    const run = await ogw(ws, ['agent', 'merge', auth, routing]);
    expect(run).toMatchObject({ code: 0, stdout: `merged ${routing}\nmerged ${auth}\n` });
    expect(sh(ws.coreImpl, 'git', ['log', '--format=%s', '-2'])).toBe(`ogw agent merge ${auth}\nogw agent merge ${routing}\n`);
    expect(existsSync(join(ws.coreImpl, 'server/auth.ts'))).toBe(true);
    expect(existsSync(join(ws.worktrees, '_core', `agent-${auth}`))).toBe(false);
    // a core worktree merges with git merge alone, without ogw data
    expect(data.calls).toEqual([]);
    // the worktree is gone, and the job's result file is the merged one in the checkout
    expect((await ogw(ws, ['agent', 'status', auth])).stdout.split('\n')[0]).toBe('done');
    const waited = (await ogw(ws, ['agent', 'wait', auth])).stdout.trim();
    expect(waited.startsWith(join(ws.coreImpl, 'records'))).toBe(true);
    expect(existsSync(waited)).toBe(true);
  });

  it('reports the jobs of modules on a dependency cycle or in an unreadable file of main, and merges the others', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], auth: ['storage'], storage: ['auth'] });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'broken.json'), '{not json');
    commitAll(ws.coreImpl, 'broken spec');
    const auth = await coreJob(ws, 'auth');
    const routing = await coreJob(ws, 'routing');
    const run = await ogw(ws, ['agent', 'merge', auth, routing]);
    expect(run.stdout).toContain(`not merged ${auth}: not defined: merge order of module auth`);
    expect(run.stdout).toContain(`merged ${routing}\n`);
  });

  it('merges a core job only after a passing ogw core test, unless it changed only records/', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [], chat: [], mail: [], shop: [] });
    const none = await coreJob(ws, 'routing', []);
    const failed = await coreJob(ws, 'storage', [PASSED, { ...PASSED, summary: { tests: 2, passed: 1 } }]);
    const vitest = await coreJob(ws, 'auth', [{ command: 'ogw code check core', startedAt: 1, exitCode: 0, summary: null }]);
    const records = await coreJob(ws, 'chat', [], 'records/chat.md');
    const exit1 = await coreJob(ws, 'mail', [{ ...PASSED, exitCode: 1 }]);
    const running = await coreJob(ws, 'shop', [{ ...PASSED, exitCode: null }]);
    const run = await ogw(ws, ['agent', 'merge', none, failed, vitest, records, exit1, running]);
    expect(run.stdout.split('\n')).toContain(`merged ${records}`);
    for (const id of [none, failed, vitest, exit1, running]) expect(run.stdout).toContain(`not merged ${id}: no core test:`);
  });

  it('does not take an ogw core test run of one test file (--file) as the last ogw core test', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    const FILE = { ...PASSED, command: 'ogw core test server routing --file server/core/routing/tests/a.test.ts' };
    const failedThenFile = await coreJob(ws, 'routing', [{ ...PASSED, exitCode: 1 }, FILE]);
    const fileOnly = await coreJob(ws, 'storage', [{ ...FILE, command: 'ogw core test server storage --file=server/core/storage/tests/a.test.ts' }]);
    const passedThenFile = await coreJob(ws, 'auth', [PASSED, { ...FILE, exitCode: 1, summary: { tests: 1, passed: 0 } }]);
    const run = await ogw(ws, ['agent', 'merge', failedThenFile, fileOnly, passedThenFile]);
    expect(run.stdout).toContain(`not merged ${failedThenFile}: no core test:`);
    expect(run.stdout).toContain(`not merged ${fileOnly}: no core test:`);
    expect(run.stdout.split('\n')).toContain(`merged ${passedThenFile}`);
  });

  it('merges a client module job without a core test until an engine core test passed every client module', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    for (const [name, side] of [['LogCore', 'client'], ['UtilCore', 'client'], ['routing', 'server']] as const) {
      writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, side, dependencies: [] }));
    }
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    const client = await coreJob(ws, 'LogCore', [], 'client/godot/core/log_core/log_core.gd');
    const server = await coreJob(ws, 'routing', []);
    const run = await ogw(ws, ['agent', 'merge', client, server]);
    expect(run.stdout.split('\n')).toContain(`merged ${client}`);
    expect(run.stdout).toContain(`not merged ${server}: no core test:`);
    // a record that passed only some client modules does not end it
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UtilCore: 'fail' }, recordedAt: 1 });
    const second = await coreJob(ws, 'UtilCore', [], 'client/godot/core/util_core/util_core.gd');
    expect((await ogw(ws, ['agent', 'merge', second])).stdout.split('\n')).toContain(`merged ${second}`);
    // a later run of some modules counts per module: each module's latest result decides
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { UtilCore: 'pass' }, recordedAt: 2 });
    const later = await coreJob(ws, 'LogCore', [], 'client/godot/core/log_core/more.gd');
    expect((await ogw(ws, ['agent', 'merge', later])).stdout).toContain(`not merged ${later}: no core test:`);
    // a failure recorded on an agent branch main does not hold is not a core test on main
    const branchCommit = sh(ws.coreImpl, 'git', ['rev-parse', `agent/${later}`]).trim();
    await addTestRecord(ws.coreImpl, { commit: branchCommit, target: 'godot', modules: { LogCore: 'fail' }, recordedAt: 3 });
    const still = await coreJob(ws, 'UtilCore', [], 'client/godot/core/util_core/still.gd');
    expect((await ogw(ws, ['agent', 'merge', still])).stdout).toContain(`not merged ${still}: no core test:`);
    // once passed, a newer failure of one module on main does not bring the exemption back
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'fail' }, recordedAt: 4 });
    const again = await coreJob(ws, 'UtilCore', [], 'client/godot/core/util_core/again.gd');
    expect((await ogw(ws, ['agent', 'merge', again])).stdout).toContain(`not merged ${again}: no core test:`);
  });

  it('merges a tool job whose core test tools left the round trip out (exit code 1, every vitest test passed) until an engine core test passed every client module', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    const skippedRun = { command: 'ogw core test tools', startedAt: 1, exitCode: 1, summary: { tests: 4, passed: 4 } };
    const failedRun = { ...skippedRun, summary: { tests: 4, passed: 3 } };
    const serverFailed = { command: 'ogw core test server', startedAt: 2, exitCode: 1, summary: { tests: 2, passed: 1 } };
    const serverPassed = { ...serverFailed, exitCode: 0, summary: { tests: 2, passed: 2 } };
    // the last `ogw core test tools` entry decides, whatever core test comes after it
    const tool = await coreJob(ws, 'contract-tool', [skippedRun, serverFailed], 'tools/contract-tool/src/a.ts');
    const failing = await coreJob(ws, 'data-tool', [failedRun, serverPassed], 'tools/data-tool/src/a.ts');
    const run = await ogw(ws, ['agent', 'merge', tool, failing]);
    expect(run.stdout.split('\n')).toContain(`merged ${tool}`);
    expect(run.stdout).toContain(`not merged ${failing}: no core test:`);
    // once a godot core test passed every client module, a tool job needs a passing core test again
    await addTestRecord(ws.coreImpl, { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    const later = await coreJob(ws, 'contract-tool', [skippedRun], 'tools/contract-tool/src/b.ts');
    expect((await ogw(ws, ['agent', 'merge', later])).stdout).toContain(`not merged ${later}: no core test:`);
  });

  it('gives the exemptions only to jobs whose --module values are all client modules, or all tools', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    for (const [name, side] of [['LogCore', 'client'], ['routing', 'server']] as const) {
      writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, side, dependencies: [] }));
    }
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    const multiJob = async (modules: string[], runs: unknown[], file: string): Promise<string> => {
      writeFileSync(join(ws.root, 'in-multi.md'), 'command: create server core\n');
      const fake = fakeAgentCli(ws, `fs.mkdirSync(${JSON.stringify(file.slice(0, file.lastIndexOf('/')))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, 'x'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'multi', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: ${JSON.stringify(runs)} }));`);
      const { id, waited } = await runAgent(ws, ['core', ...modules.flatMap((m) => ['--module', m]), '--input', join(ws.root, 'in-multi.md')], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    const skippedRun = { command: 'ogw core test tools', startedAt: 1, exitCode: 1, summary: { tests: 4, passed: 4 } };
    const clientAndServer = await multiJob(['LogCore', 'routing'], [], 'client/godot/core/log_core/a.gd');
    const toolAndModule = await multiJob(['contract-tool', 'LogCore'], [skippedRun], 'tools/contract-tool/src/a.ts');
    const run = await ogw(ws, ['agent', 'merge', clientAndServer, toolAndModule]);
    expect(run.stdout).toContain(`not merged ${clientAndServer}: no core test:`);
    expect(run.stdout).toContain(`not merged ${toolAndModule}: no core test:`);
  });

  it('merges a job of no module without a core test when it changes only files of an engine whose client core never passed', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    const head = commitAll(ws.coreImpl, 'godot');
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    const noModuleJob = async (files: string[]): Promise<string> => {
      writeFileSync(join(ws.root, 'in-engine.md'), 'command: create client core\n');
      const writes = files.map((file) => `fs.mkdirSync(${JSON.stringify(file.slice(0, file.lastIndexOf('/')))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(file)}, '{"changed":true}');`).join(' ');
      const fake = fakeAgentCli(ws, `${writes} execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'engine', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [] }));`);
      const { id, waited } = await runAgent(ws, ['core', '--input', join(ws.root, 'in-engine.md')], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    // a new engine: its engine.json comes before any of its client modules
    const engine = await noModuleJob(['client/threejs/engine.json']);
    expect((await ogw(ws, ['agent', 'merge', engine])).stdout.split('\n')).toContain(`merged ${engine}`);
    const passedEngine = await noModuleJob(['client/godot/engine.json']);
    const withServer = await noModuleJob(['client/threejs/a.json', 'server/core/x.ts']);
    // a folder under client/ without an engine.json is not an engine
    const notEngine = await noModuleJob(['client/tmp/notes.json']);
    const run = await ogw(ws, ['agent', 'merge', passedEngine, withServer, notEngine]);
    expect(run.stdout).toContain(`not merged ${passedEngine}: no core test:`);
    expect(run.stdout).toContain(`not merged ${withServer}: no core test:`);
    expect(run.stdout).toContain(`not merged ${notEngine}: no core test:`);
  });

  it('decides the exemptions per engine: a second engine whose client core never passed keeps them for its files', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    for (const engine of ['godot', 'threejs']) {
      mkdirSync(join(ws.coreImpl, 'client', engine), { recursive: true });
      writeFileSync(join(ws.coreImpl, 'client', engine, 'engine.json'), '{}');
    }
    const head = commitAll(ws.coreImpl, 'two engines');
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    const threejs = await coreJob(ws, 'LogCore', [], 'client/threejs/core/log_core.js');
    const godot = await coreJob(ws, 'LogCore', [], 'client/godot/core/log_core/a.gd');
    const toolRun = { command: 'ogw core test tools', startedAt: 1, exitCode: 1, summary: { tests: 4, passed: 4 } };
    const noTests = { ...toolRun, summary: { tests: 0, passed: 0 } };
    const tool = await coreJob(ws, 'contract-tool', [toolRun], 'tools/contract-tool/src/a.ts');
    const empty = await coreJob(ws, 'data-tool', [noTests], 'tools/data-tool/src/a.ts');
    const run = await ogw(ws, ['agent', 'merge', threejs, godot, tool, empty]);
    expect(run.stdout.split('\n')).toContain(`merged ${threejs}`);
    expect(run.stdout).toContain(`not merged ${godot}: no core test:`);
    // the threejs round trip is left out, so a tool job merges on its vitest tests; a run of no test is not a pass
    expect(run.stdout.split('\n')).toContain(`merged ${tool}`);
    expect(run.stdout).toContain(`not merged ${empty}: no core test:`);
  });

  it('keeps the client core passed when a client module is added to core-spec/ later', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    const passedAt = commitAll(ws.coreImpl, 'spec');
    await addTestRecord(ws.coreImpl, { commit: passedAt, target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'NewCore.json'), JSON.stringify({ name: 'NewCore', side: 'client', dependencies: [] }));
    commitAll(ws.coreImpl, 'a new client module');
    const job = await coreJob(ws, 'NewCore', [], 'client/godot/core/new_core/new_core.gd');
    expect((await ogw(ws, ['agent', 'merge', job])).stdout).toContain(`not merged ${job}: no core test:`);
  });

  it('reads the side of a module from main when the branch has no core-spec file of it', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'core-spec', 'LogCore.json'), JSON.stringify({ name: 'LogCore', side: 'client', dependencies: [] }));
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    const job = await coreJob(ws, 'InputCore', [], 'client/godot/core/input_core/input_core.gd');
    // ogw core spec commits the spec of InputCore on main after the worktree was made
    writeFileSync(join(ws.coreImpl, 'core-spec', 'InputCore.json'), JSON.stringify({ name: 'InputCore', side: 'client', dependencies: [] }));
    commitAll(ws.coreImpl, 'spec of InputCore');
    expect(sh(ws.coreImpl, 'git', ['ls-tree', '--name-only', `agent/${job}`, 'core-spec/'])).not.toContain('InputCore.json');
    expect((await ogw(ws, ['agent', 'merge', job])).stdout.split('\n')).toContain(`merged ${job}`);
  });

  it('orders a module the branch adds to core-spec, and leaves out only a job it cannot order', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    const added = await coreJob(ws, 'chat', [PASSED], 'core-spec/chat.json');
    const unknown = await coreJob(ws, 'guild');
    const routing = await coreJob(ws, 'routing');
    const run = await ogw(ws, ['agent', 'merge', added, unknown, routing]);
    expect(run.stdout).toContain(`not merged ${unknown}: not defined: merge order of module guild`);
    expect(run.stdout).toContain(`merged ${routing}\n`);
    expect(run.stdout).toContain(`merged ${added}\n`);
  });

  it('orders by the core-spec files a branch changed, not by the unchanged copies of another branch', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { auth: [], routing: [] });
    // the auth job makes auth depend on routing; the routing job's branch still has main's auth.json without it
    const auth = await coreJob(ws, 'auth', [PASSED], 'core-spec/auth.json');
    const routing = await coreJob(ws, 'routing');
    const run = await ogw(ws, ['agent', 'merge', auth, routing]);
    expect(run).toMatchObject({ code: 0, stdout: `merged ${routing}\nmerged ${auth}\n` });
  });

  it('does not merge a core job whose type check has a failure line that the one of main HEAD lacks', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [], chat: [] });
    mkdirSync(join(ws.coreImpl, 'server', 'core'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'old.ts'), "export const old: number = 'text';\n");
    commitAll(ws.coreImpl, 'a type check failure on main');
    typeCheck.real = true;
    const added = await scriptJob(ws, 'routing', writeScript('server/core/routing/index.ts', "export const n: number = 'text';\n"));
    const kept = await scriptJob(ws, 'storage', writeScript('server/core/storage/index.ts', 'export const s = 1;\n'));
    const records = await scriptJob(ws, 'chat', writeScript('records/chat.md', 'r'));
    const run = await ogw(ws, ['agent', 'merge', added, kept, records]);
    expect(run.stdout).toContain(`not merged ${added}: type check: server/core/routing/index.ts:1:14 TS2322 `);
    // main's own failure is not the branch's
    expect(run.stdout).not.toContain('server/core/old.ts');
    expect(run.stdout.split('\n')).toContain(`merged ${kept}`);
    expect(run.stdout.split('\n')).toContain(`merged ${records}`);
    expect(existsSync(join(ws.coreImpl, 'server', 'core', 'routing'))).toBe(false);
    // a job that changed only records/ is not type-checked
    expect(typeCheck.calls).not.toContain(`agent/${records}`);
  });

  it('type-checks the branch with the packages its worktree installed, not with the main checkout ones of another package-lock.json', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    writeFileSync(join(ws.coreImpl, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(ws.coreImpl, 'server'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'package-lock.json'), '{"lockfileVersion": 3, "packages": {}}\n');
    commitAll(ws.coreImpl, 'server package');
    // main's installed packages lack the branch's new dependency
    mkdirSync(join(ws.coreImpl, 'server', 'node_modules'), { recursive: true });
    typeCheck.real = true;
    const change = [
      writeScript('server/package.json', '{"type": "module", "dependencies": {"foo": "1.0.0"}}\n'),
      writeScript('server/package-lock.json', '{"lockfileVersion": 3, "packages": {"node_modules/foo": {"version": "1.0.0"}}}\n'),
      writeScript('server/core/routing/index.ts', "import { foo } from 'foo';\nexport const n: number = foo;\n"),
    ].join(' ');
    // what `ogw core test server` installs in the worktree from the branch's package-lock.json
    const install = [
      writeScript('server/node_modules/foo/package.json', '{"name": "foo", "version": "1.0.0", "type": "module", "exports": {".": {"types": "./index.d.ts"}}}\n'),
      writeScript('server/node_modules/foo/index.d.ts', 'export declare const foo: number;\n'),
    ].join(' ');
    const id = await scriptJob(ws, 'routing', change, install);
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
  });

  it('keeps the TypeScript failure lines of a type check whose engine part stopped, and refuses a branch that adds one', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    // the engine part stops before any engine runs: engine.json names no Godot version
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'a.gd'), 'extends Node\n');
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export const n: number = 1;\n');
    commitAll(ws.coreImpl, 'an engine without a version');
    typeCheck.real = true;
    const id = await scriptJob(ws, 'routing', writeScript('server/core/routing/index.ts', "export const n: number = 'text';\n"));
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run.stdout).toContain(`not merged ${id}: type check: server/core/routing/index.ts:1:14 TS2322 `);
    expect(run.stdout).not.toContain('client/godot/engine.json has no godot version');
    // main's check stopped: it is not kept
    expect(existsSync(join(ws.harness, '.git', 'ogw-cache', 'core-type-check'))).toBe(false);
  });

  it('refuses a branch that changed a file of the engine part that stopped, and merges one that changed only files of the other part', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], LogCore: [] });
    // the engine part stops before any engine runs: engine.json names no Godot version
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'a.gd'), 'extends Node\n');
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export const n: number = 1;\n');
    commitAll(ws.coreImpl, 'an engine without a version');
    // the engine's client core passed: a client module job is type-checked
    await addTestRecord(ws.coreImpl, { commit: sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim(), target: 'godot', modules: { LogCore: 'pass' }, recordedAt: 1 });
    typeCheck.real = true;
    const server = await scriptJob(ws, 'routing', writeScript('server/core/routing/index.ts', 'export const n: number = 2;\n'));
    const client = await scriptJob(ws, 'LogCore', writeScript('client/godot/core/log_core/log_core.gd', 'class_name LogCore\n'));
    const run = await ogw(ws, ['agent', 'merge', server, client]);
    expect(run.stdout.split('\n')).toContain(`merged ${server}`);
    expect(run.stdout).toContain(`not merged ${client}: type check: engine part stopped: client/godot/engine.json has no godot version`);
  });

  it('merges a branch that changed only a TypeScript file of another engine project while the Godot part stopped', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    // the engine part stops before any engine runs: engine.json names no Godot version
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'a.gd'), 'extends Node\n');
    mkdirSync(join(ws.coreImpl, 'client', 'threejs'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'threejs', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'threejs', 'package.json'), '{"type": "module"}\n');
    mkdirSync(join(ws.coreImpl, 'server', 'core', 'routing'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'package.json'), '{"type": "module"}\n');
    writeFileSync(join(ws.coreImpl, 'server', 'core', 'routing', 'index.ts'), 'export const n: number = 1;\n');
    commitAll(ws.coreImpl, 'an engine without a version and a TypeScript engine');
    typeCheck.real = true;
    // the TypeScript part checks the threejs file; the Godot part that stopped does not
    const id = await scriptJob(ws, 'routing', writeScript('client/threejs/core/a.ts', 'export const a: number = 1;\n'));
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
  });

  it('merges a branch whose Godot part stopped and changed none of its files when main\'s complete result is kept', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'a.gd'), 'extends Node\n');
    mkdirSync(join(ws.coreImpl, 'client', 'threejs'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'threejs', 'engine.json'), '{}');
    writeFileSync(join(ws.coreImpl, 'client', 'threejs', 'package.json'), '{"type": "module"}\n');
    commitAll(ws.coreImpl, 'an engine without a version and a TypeScript engine');
    typeCheck.real = true;
    // main's check ended while Godot worked: its kept result has no stop message
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    const folder = join(ws.harness, '.git', 'ogw-cache', 'core-type-check');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, `${main}-${sh(ws.harness, 'git', ['rev-parse', 'HEAD:tools']).trim()}.json`), '{"failures": []}');
    const id = await scriptJob(ws, 'routing', writeScript('client/threejs/core/a.ts', 'export const a: number = 1;\n'));
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run).toMatchObject({ code: 0, stdout: `merged ${id}\n` });
  });

  it('merges a branch that changed only a benchmark game TypeScript file while the TypeScript part stopped', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { storage: [] });
    const stop = 'tsc could not start';
    typeCheck.fake = () => ({ failures: [stop], complete: false, stops: [{ part: 'TypeScript', reason: stop }] });
    // the TypeScript part does not read benchmark/, so its stop checked none of the branch's files
    const storage = await coreJob(ws, 'storage', [PASSED], 'benchmark/godot/server/main.ts');
    const run = await ogw(ws, ['agent', 'merge', storage]);
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
  });

  it('refuses a branch that changed a TypeScript file when the TypeScript part stopped', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [] });
    const stop = 'tsc could not start';
    typeCheck.fake = () => ({ failures: [stop], complete: false, stops: [{ part: 'TypeScript', reason: stop }] });
    const routing = await coreJob(ws, 'routing', [PASSED], 'server/core/routing/index.ts');
    const storage = await coreJob(ws, 'storage', [PASSED], 'core-spec/storage.json');
    const run = await ogw(ws, ['agent', 'merge', routing, storage]);
    expect(run.stdout).toContain(`not merged ${routing}: type check: TypeScript part stopped: ${stop}`);
    // a branch that changed no file of the part that stopped is compared by its failure lines, which main has
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
  });

  it('checks the branch again under the main checkout lock when main changed outside records/ since the check', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [] });
    const first = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    // the branch's failure line is main's at the commit checked first; a commit made while the branch is checked drops it
    const commitOnMain = (file: string): void => {
      mkdirSync(dirname(join(ws.coreImpl, file)), { recursive: true });
      writeFileSync(join(ws.coreImpl, file), `${file}\n`);
      sh(ws.coreImpl, 'git', ['add', '--all']);
      sh(ws.coreImpl, 'git', ['commit', '--quiet', '--no-verify', '-m', file]);
    };
    let movedTo: string | null = null;
    typeCheck.fake = (commit) => {
      if (commit.startsWith('agent/') && movedTo !== null) {
        commitOnMain(movedTo);
        movedTo = null;
      }
      return { failures: commit === first || commit.startsWith('agent/') ? ['server/x.ts:1:1 TS1 old'] : [], complete: true };
    };
    const routing = await coreJob(ws, 'routing');
    movedTo = 'server/other.ts';
    const run = await ogw(ws, ['agent', 'merge', routing]);
    expect(run.stdout).toContain(`not merged ${routing}: type check: server/x.ts:1:1 TS1 old`);
    expect(typeCheck.calls.filter((commit) => commit === `agent/${routing}`)).toHaveLength(2);
    // a change only under records/ makes no second check; main's commit here has the branch's line
    commitOnMain('server/second.ts');
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    typeCheck.fake = (commit) => {
      if (commit.startsWith('agent/') && movedTo !== null) {
        commitOnMain(movedTo);
        movedTo = null;
      }
      return { failures: commit === main || commit.startsWith('agent/') ? ['server/x.ts:1:1 TS1 old'] : [], complete: true };
    };
    typeCheck.calls = [];
    const storage = await coreJob(ws, 'storage');
    movedTo = 'records/note.md';
    const merged = await ogw(ws, ['agent', 'merge', storage]);
    expect(merged.stdout).toBe(`merged ${storage}\n`);
    expect(typeCheck.calls.filter((commit) => commit === `agent/${storage}`)).toHaveLength(1);
  });

  it('makes the type check of a main commit once and keeps it in the harness git common dir, unless it stopped with an error', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    typeCheck.fake = (commit) => (commit === main ? { failures: ['engine godot is not on this host'], complete: false } : { failures: ['server/x.ts:1:1 TS1 new'], complete: true });
    const first = await coreJob(ws, 'routing');
    const second = await coreJob(ws, 'storage');
    const run = await ogw(ws, ['agent', 'merge', first, second]);
    expect(run.stdout).toContain(`not merged ${first}: type check: server/x.ts:1:1 TS1 new`);
    expect(run.stdout).toContain(`not merged ${second}: type check: server/x.ts:1:1 TS1 new`);
    const cached = join(ws.harness, '.git', 'ogw-cache', 'core-type-check', `${main}-${sh(ws.harness, 'git', ['rev-parse', 'HEAD:tools']).trim()}.json`);
    // a check that stopped with an error is made again for each job and not kept
    expect(typeCheck.calls.filter((commit) => commit === main)).toHaveLength(2);
    expect(existsSync(cached)).toBe(false);
    typeCheck.fake = (commit) => ({ failures: commit === main ? ['server/x.ts:1:1 TS1 new'] : ['server/x.ts:1:1 TS1 new'], complete: true });
    typeCheck.calls = [];
    const third = await coreJob(ws, 'auth');
    const again = await ogw(ws, ['agent', 'merge', first, third]);
    // main has the branch's failure line: both merge, and main's check of that commit was made once
    expect(again.stdout.split('\n')).toContain(`merged ${first}`);
    expect(again.stdout.split('\n')).toContain(`merged ${third}`);
    expect(typeCheck.calls.filter((commit) => commit === main)).toHaveLength(1);
    expect(JSON.parse(readFileSync(cached, 'utf8'))).toEqual({ failures: ['server/x.ts:1:1 TS1 new'] });
  });

  it('does not type-check a job the core test exemption of an engine whose client core never passed covers', async () => {
    const ws = makeWorkspace();
    mkdirSync(join(ws.coreImpl, 'core-spec'), { recursive: true });
    for (const [name, side] of [['LogCore', 'client'], ['UtilCore', 'client'], ['routing', 'server']] as const) {
      writeFileSync(join(ws.coreImpl, 'core-spec', `${name}.json`), JSON.stringify({ name, side, dependencies: [] }));
    }
    mkdirSync(join(ws.coreImpl, 'client', 'godot'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'engine.json'), '{}');
    commitAll(ws.coreImpl, 'spec');
    typeCheck.fake = (commit) => ({ failures: commit.startsWith('agent/') ? ['client/godot/core/log_core/log_core.gd:1 Could not find type "UtilCore"'] : [], complete: true });
    const client = await coreJob(ws, 'LogCore', [PASSED], 'client/godot/core/log_core/log_core.gd');
    const server = await coreJob(ws, 'routing');
    const run = await ogw(ws, ['agent', 'merge', client, server]);
    expect(run.stdout.split('\n')).toContain(`merged ${client}`);
    expect(typeCheck.calls).not.toContain(`agent/${client}`);
    expect(run.stdout).toContain(`not merged ${server}: type check: client/godot/core/log_core/log_core.gd:1 Could not find type "UtilCore"`);
    // once the engine's client core passed, a client module job is type-checked
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    await addTestRecord(ws.coreImpl, { commit: head, target: 'godot', modules: { LogCore: 'pass', UtilCore: 'pass' }, recordedAt: 1 });
    const later = await coreJob(ws, 'UtilCore', [PASSED], 'client/godot/core/util_core/util_core.gd');
    expect((await ogw(ws, ['agent', 'merge', later])).stdout).toContain(`not merged ${later}: type check:`);
  });

  it('compares type check failure lines by file, code and message, not by line and column', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [] });
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    typeCheck.fake = (commit) => ({
      failures: commit === main ? ['server/a.ts:3:5 TS2322 x', 'client/godot/core/a.gd:7 Parse Error'] : ['server/a.ts:9:1 TS2322 x', 'client/godot/core/a.gd:12 Parse Error', ...(commit === `agent/${storage}` ? ['server/a.ts:9:1 TS2554 y'] : [])],
      complete: true,
    });
    const routing = await coreJob(ws, 'routing');
    const storage = await coreJob(ws, 'storage');
    const run = await ogw(ws, ['agent', 'merge', routing, storage]);
    expect(run.stdout.split('\n')).toContain(`merged ${routing}`);
    expect(run.stdout).toContain(`not merged ${storage}: type check: server/a.ts:9:1 TS2554 y\n`);
  });

  it('keys the type check of main by the commit and the harness tools/ tree, and keeps none while tools/ has changes not committed', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    const main = sh(ws.coreImpl, 'git', ['rev-parse', 'main']).trim();
    // every job is refused, so main stays at one commit
    typeCheck.fake = (commit) => ({ failures: commit.startsWith('agent/') ? ['server/x.ts:1:1 TS1 new'] : [], complete: true });
    const cached = (): string[] => {
      const folder = join(ws.harness, '.git', 'ogw-cache', 'core-type-check');
      return existsSync(folder) ? readdirSync(folder) : [];
    };
    const mainChecks = (): number => typeCheck.calls.filter((commit) => commit === main).length;
    await ogw(ws, ['agent', 'merge', await coreJob(ws, 'routing')]);
    await ogw(ws, ['agent', 'merge', await coreJob(ws, 'routing')]);
    expect(mainChecks()).toBe(1);
    const tree = sh(ws.harness, 'git', ['rev-parse', 'HEAD:tools']).trim();
    expect(cached()).toEqual([`${main}-${tree}.json`]);
    // a changed harness tools/ tree makes main's check again
    appendFileSync(join(ws.harness, 'tools', 'ogw.md'), 'x\n');
    await ogw(ws, ['agent', 'merge', await coreJob(ws, 'storage')]);
    expect(mainChecks()).toBe(2);
    expect(cached()).toHaveLength(1);
    commitAll(ws.harness, 'tools changed');
    await ogw(ws, ['agent', 'merge', await coreJob(ws, 'auth')]);
    expect(mainChecks()).toBe(3);
    expect(cached()).toHaveLength(2);
  });

  it('does not merge into a main with uncommitted changes', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    const id = await coreJob(ws, 'routing');
    writeFileSync(join(ws.coreImpl, 'core-spec/routing.json'), '{"name":"routing","dependencies":["x"]}');
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run.stdout).toContain(`not merged ${id}: uncommitted changes:`);
  });

  it('waits for another change of the main checkout to end before it merges', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    const id = await coreJob(ws, 'routing');
    let release: () => void = () => undefined;
    let held: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const holder = withCoreMain(ws.coreImpl, ws.env, () => {
      held();
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    });
    await holding;
    let done = false;
    const merging = ogw(ws, ['agent', 'merge', id]).then((run) => {
      done = true;
      return run;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(done).toBe(false);
    release();
    await holder;
    expect((await merging).stdout.split('\n')).toContain(`merged ${id}`);
  });

  it('merges a core job only after the module tests of a core test run on the main checkout end', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    const id = await coreJob(ws, 'routing');
    const reader = await testAtHead(ws.coreImpl, ws.coreImpl, ws.env, () => Promise.resolve());
    let done = false;
    const merging = ogw(ws, ['agent', 'merge', id]).then((run) => {
      done = true;
      return run;
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    expect(done).toBe(false);
    await reader.release();
    expect((await merging).stdout.split('\n')).toContain(`merged ${id}`);
  });

  it('merges the core settings files of parallel core jobs key by key, and stops at a key both set differently', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    mkdirSync(join(ws.coreImpl, 'settings'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), '{\n  "routing.a": 1\n}\n');
    commitAll(ws.coreImpl, 'settings');
    const settingsJob = async (module: string, values: Record<string, number>): Promise<string> => {
      writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
      const fake = fakeAgentCli(ws, `fs.writeFileSync('settings/core-settings.json', JSON.stringify(${JSON.stringify({ 'routing.a': 1, ...values })}, null, 2) + '\\n'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
      const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    const storage = await settingsJob('storage', { 'storage.b': 2 });
    const auth = await settingsJob('auth', { 'auth.c': 3 });
    const routing = await settingsJob('routing', { 'storage.b': 9 });
    const run = await ogw(ws, ['agent', 'merge', storage, auth]);
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
    expect(run.stdout.split('\n')).toContain(`merged ${auth}`);
    expect(JSON.parse(readFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), 'utf8'))).toEqual({ 'routing.a': 1, 'storage.b': 2, 'auth.c': 3 });
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
    const clash = await ogw(ws, ['agent', 'merge', routing]);
    expect(clash.stdout).toContain(`not merged ${routing}: conflict: settings/core-settings.json: both sides changed storage.b`);
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('merges the required names of the core settings schema that parallel jobs added, and not a required value of the settings', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { storage: [], auth: [], chat: [], mail: [] });
    mkdirSync(join(ws.coreImpl, 'settings'), { recursive: true });
    const schema = (props: string[], required: string[]): string => `${JSON.stringify({ type: 'object', properties: Object.fromEntries(props.map((p) => [p, { type: 'integer' }])), required }, null, 2)}\n`;
    writeFileSync(join(ws.coreImpl, 'settings', 'core-settings.schema.json'), schema(['routing.a', 'routing.old'], ['routing.a', 'routing.old']));
    writeFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), `${JSON.stringify({ 'routing.a': 1, consent: { required: ['terms'] } }, null, 2)}\n`);
    commitAll(ws.coreImpl, 'settings');
    const job = async (module: string, files: Record<string, string>): Promise<string> => {
      writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
      const writes = Object.entries(files).map(([f, t]) => `fs.writeFileSync(${JSON.stringify(f)}, ${JSON.stringify(t)});`).join(' ');
      const fake = fakeAgentCli(ws, `${writes} execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
      const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    // storage adds its key and drops routing.old; auth adds its key
    const storage = await job('storage', { 'settings/core-settings.schema.json': schema(['routing.a', 'storage.b'], ['routing.a', 'storage.b']) });
    const auth = await job('auth', { 'settings/core-settings.schema.json': schema(['routing.a', 'routing.old', 'auth.c'], ['routing.a', 'routing.old', 'auth.c']) });
    const run = await ogw(ws, ['agent', 'merge', storage, auth]);
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
    expect(run.stdout.split('\n')).toContain(`merged ${auth}`);
    const merged = JSON.parse(readFileSync(join(ws.coreImpl, 'settings', 'core-settings.schema.json'), 'utf8')) as { required: string[] };
    expect([...merged.required].sort()).toEqual(['auth.c', 'routing.a', 'storage.b']);
    // a settings value under a key named `required` both sides changed differently is a conflict: only the schema has name lists
    const settings = (value: string[]): string => `${JSON.stringify({ 'routing.a': 1, consent: { required: value } }, null, 2)}\n`;
    const chat = await job('chat', { 'settings/core-settings.json': settings(['terms', 'age']) });
    const mail = await job('mail', { 'settings/core-settings.json': settings([]) });
    expect((await ogw(ws, ['agent', 'merge', chat])).stdout.split('\n')).toContain(`merged ${chat}`);
    expect((await ogw(ws, ['agent', 'merge', mail])).stdout).toContain(`not merged ${mail}: conflict: settings/core-settings.json: both sides changed consent.required`);
  });

  it('keeps main\'s generated files where parallel core jobs wrote them differently, with the settings merged key by key', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { storage: [], auth: [] });
    mkdirSync(join(ws.coreImpl, 'settings'), { recursive: true });
    mkdirSync(join(ws.coreImpl, 'client', 'godot', 'generated'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), '{\n  "routing.a": 1\n}\n');
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'generated', 'core_settings.json'), '{\n  "routing.a": 1\n}\n');
    commitAll(ws.coreImpl, 'settings');
    // each job's core test wrote the generated core settings file of its own worktree
    const job = async (module: string, key: string): Promise<string> => {
      writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
      const values = JSON.stringify({ 'routing.a': 1, [key]: 2 });
      const fake = fakeAgentCli(ws, `for (const f of ['settings/core-settings.json', 'client/godot/generated/core_settings.json']) fs.writeFileSync(f, JSON.stringify(${values}, null, 2) + '\\n'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
      const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    const storage = await job('storage', 'storage.b');
    const auth = await job('auth', 'auth.c');
    const run = await ogw(ws, ['agent', 'merge', storage, auth]);
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
    expect(run.stdout.split('\n')).toContain(`merged ${auth}`);
    expect(JSON.parse(readFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), 'utf8'))).toEqual({ 'routing.a': 1, 'storage.b': 2, 'auth.c': 2 });
    // the generated file stays as main had it when the second job merged: the first job's
    const first = sh(ws.coreImpl, 'git', ['log', '--format=%s', '--grep=ogw agent merge', '--reverse']).split('\n')[0] ?? '';
    const firstKey = first.endsWith(storage) ? 'storage.b' : 'auth.c';
    expect(JSON.parse(readFileSync(join(ws.coreImpl, 'client', 'godot', 'generated', 'core_settings.json'), 'utf8'))).toEqual({ 'routing.a': 1, [firstKey]: 2 });
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('keeps a generated file deleted when main deleted it and a core job changed it', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { storage: [] });
    mkdirSync(join(ws.coreImpl, 'client', 'godot', 'generated'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'client', 'godot', 'generated', 'core_modules.gd'), 'old\n');
    commitAll(ws.coreImpl, 'generated');
    writeFileSync(join(ws.root, 'in-storage.md'), 'command: create server core\n');
    const fake = fakeAgentCli(ws, `fs.writeFileSync('client/godot/generated/core_modules.gd', 'new\\n'); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', 'storage', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
    const { id, waited } = await runAgent(ws, ['core', '--module', 'storage', '--input', join(ws.root, 'in-storage.md')], fake.env);
    expect(waited.code).toBe(0);
    sh(ws.coreImpl, 'git', ['rm', '-q', 'client/godot/generated/core_modules.gd']);
    commitAll(ws.coreImpl, 'main deletes the generated file');
    expect((await ogw(ws, ['agent', 'merge', id])).stdout.split('\n')).toContain(`merged ${id}`);
    expect(existsSync(join(ws.coreImpl, 'client', 'godot', 'generated', 'core_modules.gd'))).toBe(false);
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('stops at a conflict in a hand-written core test data file, and at one in another file next to a resolvable one', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { storage: [], auth: [] });
    mkdirSync(join(ws.coreImpl, 'settings'), { recursive: true });
    mkdirSync(join(ws.coreImpl, 'test-data', 'data', 'fixtures'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'settings', 'core-settings.json'), '{\n  "routing.a": 1\n}\n');
    writeFileSync(join(ws.coreImpl, 'test-data', 'data', 'fixtures', 'f.json'), '{"a": 0}\n');
    mkdirSync(join(ws.coreImpl, 'server'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server', 'x.ts'), 'base\n');
    commitAll(ws.coreImpl, 'base');
    const job = async (module: string, files: Record<string, string>): Promise<string> => {
      writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
      const writes = Object.entries(files).map(([f, t]) => `fs.writeFileSync(${JSON.stringify(f)}, ${JSON.stringify(t)});`).join(' ');
      const fake = fakeAgentCli(ws, `${writes} execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
      const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    const storage = await job('storage', { 'test-data/data/fixtures/f.json': '{"a": 1}\n', 'server/x.ts': 'storage\n', 'settings/core-settings.json': '{\n  "routing.a": 1,\n  "storage.b": 2\n}\n' });
    const auth = await job('auth', { 'test-data/data/fixtures/f.json': '{"a": 2}\n' });
    const mixed = await job('auth', { 'server/x.ts': 'auth\n', 'settings/core-settings.json': '{\n  "routing.a": 1,\n  "auth.c": 3\n}\n' });
    expect((await ogw(ws, ['agent', 'merge', storage])).stdout.split('\n')).toContain(`merged ${storage}`);
    const head = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    expect((await ogw(ws, ['agent', 'merge', auth])).stdout).toContain(`not merged ${auth}: conflict`);
    expect((await ogw(ws, ['agent', 'merge', mixed])).stdout).toContain(`not merged ${mixed}: conflict`);
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('merges core test data CSV rows that parallel core jobs added', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    mkdirSync(join(ws.coreImpl, 'test-data', 'data', 'translations'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'test-data', 'data', 'translations', 'en.csv'), 'key,text\nbase,Base\n');
    commitAll(ws.coreImpl, 'test data');
    const rowJob = async (module: string, row: string): Promise<string> => {
      writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
      const fake = fakeAgentCli(ws, `fs.appendFileSync('test-data/data/translations/en.csv', ${JSON.stringify(`${row}\n`)}); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
      const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    const storage = await rowJob('storage', 'storage_text,Storage');
    const auth = await rowJob('auth', 'auth_text,Auth');
    const run = await ogw(ws, ['agent', 'merge', storage, auth]);
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
    expect(run.stdout.split('\n')).toContain(`merged ${auth}`);
    expect(readFileSync(join(ws.coreImpl, 'test-data', 'data', 'translations', 'en.csv'), 'utf8')).toBe('key,text\nbase,Base\nauth_text,Auth\nstorage_text,Storage\n');
  });

  it('merges rows of a core test data table with its 4-row header, and stops at a key both jobs added differently', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [], storage: [], auth: [] });
    const table = join(ws.coreImpl, 'test-data', 'data', 'tables', 'x.csv');
    const header = ',,\nAll,All,Server\nid(key),int,int\nid,amount,weight\n';
    mkdirSync(dirname(table), { recursive: true });
    writeFileSync(table, `${header}[a],1,10\n`);
    commitAll(ws.coreImpl, 'table');
    const rowJob = async (module: string, row: string): Promise<string> => {
      writeFileSync(join(ws.root, `in-${module}.md`), 'command: create server core\n');
      const fake = fakeAgentCli(ws, `fs.appendFileSync('test-data/data/tables/x.csv', ${JSON.stringify(`${row}\n`)}); execFileSync('git', ['add', '-A']); execFileSync('git', ['commit', '-qm', '${module}', '--no-verify']); fs.writeFileSync(output, 'r'); fs.writeFileSync(output.replace(/\\.md$/, '-runs.json'), JSON.stringify({ runs: [${JSON.stringify(PASSED)}] }));`);
      const { id, waited } = await runAgent(ws, ['core', '--module', module, '--input', join(ws.root, `in-${module}.md`)], fake.env);
      expect(waited.code).toBe(0);
      return id;
    };
    const auth = await rowJob('auth', '[b],2,20');
    const storage = await rowJob('storage', '[c],3,30');
    const routing = await rowJob('routing', '[c],9,90');
    const run = await ogw(ws, ['agent', 'merge', auth, storage]);
    expect(run.stdout.split('\n')).toContain(`merged ${auth}`);
    expect(run.stdout.split('\n')).toContain(`merged ${storage}`);
    expect(readFileSync(table, 'utf8')).toBe(`${header}[a],1,10\n[b],2,20\n[c],3,30\n`);
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const clash = await ogw(ws, ['agent', 'merge', routing]);
    expect(clash.stdout).toContain(`not merged ${routing}: conflict: test-data/data/tables/x.csv: both sides have a row of key [c]`);
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('is a conflict when git cannot merge, and leaves main as it was', async () => {
    const ws = makeWorkspace();
    coreSpec(ws, { routing: [] });
    const id = await coreJob(ws, 'routing');
    mkdirSync(join(ws.coreImpl, 'server'), { recursive: true });
    writeFileSync(join(ws.coreImpl, 'server/routing.ts'), 'main version');
    sh(ws.coreImpl, 'git', ['add', '-A']);
    sh(ws.coreImpl, 'git', ['commit', '-qm', 'main routing', '--no-verify']);
    const before = sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim();
    const run = await ogw(ws, ['agent', 'merge', id]);
    expect(run.stdout).toContain(`not merged ${id}: conflict:`);
    expect(sh(ws.coreImpl, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    expect(sh(ws.coreImpl, 'git', ['status', '--porcelain'])).toBe('');
  });
});
