import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { testAtHead, withCoreMain } from '../../../src/commands/core/lib/main-checkout.ts';
import { ogw, commitAll, makeWorkspace, sh } from '../../helpers/workspace.ts';
import { fakeAgentCli, runAgent } from './helpers.ts';
import { coreJob, coreSpec, PASSED } from './merge-core-fixture.ts';

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

describe('ogw agent merge: core worktrees', () => {
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
