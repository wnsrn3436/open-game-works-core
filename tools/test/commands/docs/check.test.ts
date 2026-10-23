import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { failureLine, ITEMS, SPEC_ITEMS } from '../../../src/commands/docs/check.ts';
import { mdLines } from '../../../src/commands/core/lib/spec-md.ts';
import {
  checkHumanPrep,
  checkNativeAgents,
  checkSchema,
  HUMAN_PREP_BULLET_STARTS,
} from '../../../src/commands/docs/lib/misc-items.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';

const workspaces: TestWorkspace[] = [];
function workspace(): TestWorkspace {
  const ws = makeWorkspace();
  workspaces.push(ws);
  return ws;
}
afterEach(() => {
  for (const ws of workspaces.splice(0)) rmSync(ws.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

interface Output {
  ok: boolean;
  items: { name: string; result: string }[];
  failures: { item: string; where: string; reason: string }[];
}

async function check(ws: TestWorkspace): Promise<{ code: number; out: Output }> {
  const run = await ogw(ws, ['docs', 'check', '--json']);
  return { code: run.code, out: JSON.parse(run.stdout) as Output };
}

describe('misc items', () => {
  it('validates harness settings against the schema', async () => {
    const ws = workspace();
    expect(await checkSchema(ws.harness)).toEqual([]);
    const settings = JSON.parse(readFileSync(join(ws.harness, 'settings.json'), 'utf8')) as Record<string, unknown>;
    writeFileSync(join(ws.harness, 'settings.json'), JSON.stringify({ ...settings, reviewRounds: 'many' }));
    const failures = await checkSchema(ws.harness);
    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0]).toMatchObject({ item: 'schema', where: 'settings.json' });
    expect(failures.map((f) => f.reason).join('\n')).toContain('/reviewRounds');
    writeFileSync(join(ws.harness, 'settings.json'), '{');
    expect((await checkSchema(ws.harness))[0]?.reason).toContain('invalid JSON');
  });

  it('fails native agent folders', () => {
    const ws = workspace();
    expect(checkNativeAgents(ws.harness)).toEqual([]);
    mkdirSync(join(ws.harness, '.codex', 'agents'), { recursive: true });
    expect(checkNativeAgents(ws.harness)).toEqual([{ item: 'native agents', where: '.codex/agents', reason: 'native agent definitions must not exist' }]);
  });

  it('needs one bullet in ## deploy per human prep start text', () => {
    const build = {
      rel: 'skills/build/SKILL.md',
      abs: '/h/skills/build/SKILL.md',
      lines: mdLines('# b\n\n## deploy\n\n- `a` is x\n  - `c` nested only\n  - `d` nested\n- `b` z\n- `b` w\n- `d` top\n\n## other\n\n- `c` outside\n'),
    };
    expect(checkHumanPrep(build, ['`a` is', '`b`', '`c`', '`d`'])).toEqual([
      { item: 'human prep', where: 'skills/build/SKILL.md:8', reason: '2 bullets in ## deploy start with "`b`" (lines 8, 9); there must be one' },
      { item: 'human prep', where: 'skills/build/SKILL.md', reason: '0 bullets in ## deploy start with "`c`"; there must be one' },
    ]);
    expect(checkHumanPrep({ ...build, lines: mdLines('# b\n\n## other\n') })).toEqual([
      { item: 'human prep', where: 'skills/build/SKILL.md', reason: 'no ## deploy section' },
    ]);
    expect(checkHumanPrep(undefined)).toEqual([{ item: 'human prep', where: 'skills/build/SKILL.md', reason: 'no ## deploy section' }]);
    expect(HUMAN_PREP_BULLET_STARTS).toHaveLength(9);
  });
});

describe('ogw docs check', () => {
  it('passes every item on the harness copy', async () => {
    const ws = workspace();
    const { code, out } = await check(ws);
    expect(out.failures).toEqual([]);
    expect(code).toBe(0);
    expect(out.ok).toBe(true);
    expect(out.items).toEqual(ITEMS.map((name) => ({ name, result: 'pass' })));
    expect((await ogw(ws, ['docs', 'check'])).stdout).toBe(`docs check: ${String(ITEMS.length)} items pass\n`);
  });

  it('lists failures in item order with the item name', async () => {
    const ws = workspace();
    const notes = join(ws.harness, 'tools', 'notes.md');
    writeFileSync(notes, 'a subagent\nWrite it properly\n');
    const spec = join(ws.harness, 'skills', 'server-core', 'modules', 'chat.md');
    writeFileSync(spec, `${readFileSync(spec, 'utf8')}\n- \`storage.no_such_operation\`\n`);
    const { code, out } = await check(ws);
    expect(code).toBe(1);
    expect(out.ok).toBe(false);
    expect(out.failures).toEqual([
      { item: 'terms', where: 'tools/notes.md:1', reason: '"subagent" is a synonym; write "sub-agent"' },
      { item: 'writing', where: 'tools/notes.md:2', reason: 'uses "properly", which cannot be judged' },
      expect.objectContaining({ item: 'spec reference', reason: '`storage.no_such_operation`: storage has no operation, event or hook `no_such_operation`' }),
    ]);
    const results = Object.fromEntries(out.items.map((i) => [i.name, i.result]));
    expect(Object.entries(results).filter(([, r]) => r === 'fail').map(([n]) => n)).toEqual(['terms', 'writing', 'spec reference']);
    const run = await ogw(ws, ['docs', 'check']);
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(`${out.failures.map(failureLine).join('\n')}\n`);
  });

  it('reads untracked documents but not git-ignored files, symbolic links, README.md or README.ko.md', async () => {
    const ws = workspace();
    mkdirSync(join(ws.harness, 'tools', 'node_modules', 'pkg'), { recursive: true });
    writeFileSync(join(ws.harness, '.gitignore'), 'tools/node_modules/\n');
    writeFileSync(join(ws.harness, 'tools', 'node_modules', 'pkg', 'x.md'), 'a subagent\n');
    writeFileSync(join(ws.harness, 'README.md'), 'a subagent\n');
    writeFileSync(join(ws.harness, 'README.ko.md'), 'a subagent, 한국어\n');
    writeFileSync(join(ws.harness, 'tools', 'notes.md'), 'an orchestrator\n');
    const { out } = await check(ws);
    expect(out.failures.filter((f) => f.item === 'terms')).toEqual([
      { item: 'terms', where: 'tools/notes.md:1', reason: '"orchestrator" is a synonym; write "lead agent"' },
    ]);
  });

  it('reports injected defects of the items', async () => {
    const ws = workspace();
    mkdirSync(join(ws.harness, '.claude', 'agents'), { recursive: true });
    const agents = join(ws.harness, 'agents', 'play.md');
    writeFileSync(agents, `${readFileSync(agents, 'utf8')}\nsee [nothing](../missing.md)\n`);
    const { out } = await check(ws);
    expect(out.failures).toContainEqual({ item: 'native agents', where: '.claude/agents', reason: 'native agent definitions must not exist' });
    expect(out.failures.some((f) => f.item === 'references' && f.reason === 'link target ../missing.md does not exist')).toBe(true);
  });

  it('reports ogw core spec --check violations under core spec with their location', async () => {
    const ws = workspace();
    const spec = join(ws.harness, 'skills', 'server-core', 'modules', 'chat.md');
    writeFileSync(spec, readFileSync(spec, 'utf8').replace('- `block-report`\n', '- `block-report`\n- `no-such-module`\n'));
    const { code, out } = await check(ws);
    expect(code).toBe(1);
    expect(out.failures).toContainEqual({
      item: 'core spec',
      where: 'skills/server-core/modules/chat.md:28',
      reason: 'dependency line names `no-such-module`, which is not a module',
    });
    expect(out.items).toContainEqual({ name: 'core spec', result: 'fail' });
  });

  it('reports a spec that cannot be read under core spec and still runs the other items', async () => {
    const ws = workspace();
    const skill = join(ws.harness, 'skills', 'server-core', 'SKILL.md');
    writeFileSync(skill, readFileSync(skill, 'utf8').replace('(modules/coupon.md)', '(modules/coupon-missing.md)'));
    writeFileSync(join(ws.harness, 'tools', 'notes.md'), 'a subagent\n');
    const { code, out } = await check(ws);
    expect(code).toBe(1);
    expect(out.failures).toContainEqual({ item: 'core spec', where: '', reason: 'spec file not found: skills/server-core/modules/coupon-missing.md' });
    expect(out.failures.some((f) => f.item === 'references' && f.reason === 'link target modules/coupon-missing.md does not exist')).toBe(true);
    expect(out.failures.some((f) => f.item === 'terms')).toBe(true);
    const notRun = { result: 'unknown', reason: 'not run: the module specs could not be parsed (see core spec)' };
    for (const name of SPEC_ITEMS) expect(out.items).toContainEqual({ name, ...notRun });
    expect(out.items).toContainEqual({ name: 'core spec', result: 'fail' });
    expect(out.items).toContainEqual({ name: 'human prep', result: 'pass' });
    expect(out.items.filter((item) => item.result === 'pass').map((item) => item.name)).not.toContain('spec heading');
  });

  it('fails a link whose target is a folder', async () => {
    const ws = workspace();
    mkdirSync(join(ws.harness, 'skills', 'core', 'sub'), { recursive: true });
    const skill = join(ws.harness, 'skills', 'core', 'SKILL.md');
    writeFileSync(skill, `${readFileSync(skill, 'utf8')}\nsee [d](sub/)\n`);
    const { out } = await check(ws);
    expect(out.failures.filter((f) => f.item === 'references')).toEqual([
      expect.objectContaining({ item: 'references', reason: 'link target sub/ is not a file' }),
    ]);
  });

  it('takes no arguments', async () => {
    const ws = workspace();
    expect((await ogw(ws, ['docs', 'check', 'x'])).stderr).toBe('usage: ogw docs check\n');
  });

  it('formats failure lines with and without a location', () => {
    expect(failureLine({ item: 'a', where: 'f:1', reason: 'r' })).toBe('a: f:1: r');
    expect(failureLine({ item: 'a', where: '', reason: 'r' })).toBe('a: r');
  });
});
