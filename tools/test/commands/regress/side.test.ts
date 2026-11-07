import { chmodSync, existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { regressChecks } from '../../../src/commands/check/api.ts';
import { makeSide, removeSide, requireSameCore, sideAgent, sideCheck, sideOgw, type Side } from '../../../src/commands/regress/lib/side.ts';
import { joinedNames, promptBytes } from '../../../src/commands/regress/side-commands.ts';
import { ogw, makeWorkspace, sh, type TestWorkspace } from '../../helpers/workspace.ts';
import { ctxOf, item, sourceGame, write } from './helpers.ts';

vi.mock('../../../src/commands/check/api.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/commands/check/api.ts')>()),
  regressChecks: vi.fn(),
}));

/** A side tool `tools/bin/ogw` in a harness commit that answers `ogw regress side --json` with what it was run with. */
function fakeSideTool(ws: TestWorkspace, body: string): string {
  write(ws.harness, 'tools/bin/ogw', `#!/bin/sh\n${body}\n`);
  chmodSync(join(ws.harness, 'tools/bin/ogw'), 0o755);
  sh(ws.harness, 'git', ['add', '-A']);
  sh(ws.harness, 'git', ['commit', '-qm', 'side tool']);
  return sh(ws.harness, 'git', ['rev-parse', 'HEAD']).trim();
}

const INFO = `if [ "$1 $2" = "regress side" ]; then printf '{"commit":"c","coreVersion":"1.0.0","promptBytes":{"content":1,"translation":2},"agents":{},"harness":"%s","workspace":"%s","settings":%s}' "$OGW_HARNESS_ROOT" "$OGW_WORKSPACE_ROOT" "$(cat "$OGW_HARNESS_ROOT/settings.local.json" 2>/dev/null || echo null)"; exit 0; fi; echo "unknown command" >&2; exit 1`;

describe('side', () => {
  it('is a worktree of its commit under worktrees/_harness with its node_modules, its settings.local.json and its side tool', async () => {
    const ws = makeWorkspace();
    write(ws.harness, 'settings.local.json', JSON.stringify({ maxConcurrentInstances: 3, agents: { judge: { cli: 'codex', model: 'j', effort: 'low' }, content: { cli: 'codex', model: 'local', effort: 'low' } } }));
    const commit = fakeSideTool(ws, INFO);
    const side = await makeSide(ctxOf(ws), { name: 'after', commit, agents: { content: { cli: 'claude-code', model: 'm2', effort: 'high' } } });
    expect(side.unknown).toBeNull();
    expect(side.worktree?.startsWith(join(ws.worktrees, '_harness'))).toBe(true);
    const info = side.info as unknown as { harness: string; workspace: string; settings: Record<string, unknown> };
    expect(info.harness).toBe(side.worktree);
    expect(info.workspace).toBe(ws.root);
    // the local settings of the harness repo, with the agents of the side over them
    expect(info.settings).toEqual({ maxConcurrentInstances: 3, agents: { judge: { cli: 'codex', model: 'j', effort: 'low' }, content: { cli: 'claude-code', model: 'm2', effort: 'high' } } });
    expect(lstatSync(join(side.worktree ?? '', 'tools', 'node_modules')).isSymbolicLink()).toBe(true);
    await removeSide(ctxOf(ws), side);
    expect(existsSync(side.worktree ?? '')).toBe(false);
    expect(sh(ws.harness, 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
  });

  it('is unknown when its side tool does not run ogw regress side, and when the commit does not exist', async () => {
    const ws = makeWorkspace();
    const commit = fakeSideTool(ws, 'echo "unknown command regress side" >&2; exit 1');
    const old = await makeSide(ctxOf(ws), { name: 'before', commit, agents: {} });
    expect(old.unknown).toMatch(/^the side tool of [0-9a-f]+ does not run ogw regress side: ogw regress side exit 1: unknown command regress side$/);
    await removeSide(ctxOf(ws), old);
    const none = await makeSide(ctxOf(ws), { name: 'before', commit: 'f'.repeat(40), agents: {} });
    expect(none.unknown).toMatch(/^the side worktree of f+ could not be made: /);
  });

  it('runs the side commands of the harness repo itself in this process', async () => {
    const ws = makeWorkspace();
    sh(ws.harness, 'git', ['tag', 'core-v1.0.0']);
    const self: Side = { name: 'after', commit: 'x', agents: {}, worktree: null, info: null, unknown: null };
    const out = await sideOgw(ctxOf(ws), self, ['regress', 'side', '--json']);
    expect(out.code).toBe(0);
    const info = JSON.parse(out.stdout) as { coreVersion: string; promptBytes: { content: number; translation: number } };
    expect(info.coreVersion).toBe('1.0.0');
    expect(info.promptBytes.content).toBe(await promptBytes(ws.harness, 'content'));
  });

  it('leaves the cwd of a side worktree out of the game a command works on', async () => {
    const ws = makeWorkspace();
    sourceGame(ws, 'g');
    const inSide = join(ws.worktrees, '_harness', 's1', 'tools');
    write(inSide, 'x', '');
    const ctx = { ...ctxOf(ws), cwd: inSide };
    const game = await (await import('../../../src/lib/game.ts')).resolveGame(await ctx.workspace(), 'g', inSide, ws.env);
    expect(game).toMatchObject({ root: join(ws.games, 'g'), inWorktree: false });
  });

  it('needs the same core version on both sides', () => {
    const info = (coreVersion: string | null) => ({ commit: 'c', coreVersion, promptBytes: { content: 0, translation: 0 }, agents: {} });
    expect(requireSameCore(info('1.0.0'), info('1.0.0'))).toBe('1.0.0');
    expect(() => requireSameCore(info('0.9.0'), info('1.0.0'))).toThrow('before c (core-v0.9.0), after c (core-v1.0.0)');
    expect(() => requireSameCore(info(null), info(null))).toThrow('no core-v tag');
  });
});

describe('side commands', () => {
  it('prompt bytes: the prompt and each harness file it links, once', async () => {
    const ws = makeWorkspace();
    const bytes = await promptBytes(ws.harness, 'content');
    const agents = readFileSync(join(ws.harness, 'agents', 'content.md'));
    expect(bytes).toBeGreaterThan(agents.length);
    write(ws.harness, 'agents/content.md', `${agents.toString('utf8')}\n[again](../skills/game-design/SKILL.md) [again](../skills/game-design/SKILL.md#x)\n`);
    const more = await promptBytes(ws.harness, 'content');
    // the second link names a file the prompt links already: only its text counts again
    expect(more - bytes).toBe(Buffer.byteLength('\n[again](../skills/game-design/SKILL.md) [again](../skills/game-design/SKILL.md#x)\n') + (2 * join(ws.harness, '/').length - 2 * '../'.length));
  });

  it('ogw regress check: the picked checks in a worktree of the commit, the fix test proof of the seed-run, the file, and no worktree left', async () => {
    const ws = makeWorkspace();
    const commit = sourceGame(ws, 'g');
    const seen: { root: string; only: string[] | null; performance: boolean; proof: unknown }[] = [];
    vi.mocked(regressChecks).mockImplementation((_ctx, game, _evidence, pick, proof) => {
      seen.push({ root: game.root, only: pick.only === null ? null : [...pick.only], performance: pick.performance, proof });
      return Promise.resolve({ checks: [item('no blocker', 'pass'), item('full flow', 'pass')], fixTestProof: [] });
    });
    const out = join(ws.root, 'out', 'check.json');
    const run = await ogw(ws, ['regress', 'check', 'g', '--commit', 'main', '--out', out, '--check', 'no', 'blocker', '--check', 'full flow', '--proof', 'regress-1-2:3']);
    expect(run.stderr).toBe('');
    expect(run.code).toBe(0);
    expect(seen.map((s) => ({ ...s, root: s.root.startsWith(join(ws.worktrees, 'g', 'regress-')) }))).toEqual([{ root: true, only: ['no blocker', 'full flow'], performance: false, proof: { records: 'regress-1-2', iteration: 3, commit } }]);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({ commit, checks: [item('no blocker', 'pass'), item('full flow', 'pass')], fixTestProof: [] });
    expect(sh(join(ws.games, 'g'), 'git', ['worktree', 'list']).trim().split('\n')).toHaveLength(1);
    expect((await ogw(ws, ['regress', 'check', 'g', '--commit', 'main', '--out', out, '--check', 'nothing'])).stderr).toContain('unknown check: nothing');
    expect((await ogw(ws, ['regress', 'check', 'g', '--commit', 'main', '--out', join(ws.root, 'x.txt')])).stderr).toContain('--out ends with .json');
  });

  it('joins the words of multi-word check names', () => {
    expect(joinedNames(['no', 'blocker', 'UI quality', 'static', 'check'])).toEqual(['no blocker', 'UI quality', 'static check']);
    expect(joinedNames(['bogus'])).toEqual(['bogus']);
  });

  it('a side check that fails or prints no JSON is an error, and a side agent that fails is failed with its reason', async () => {
    const ws = makeWorkspace();
    const agent = `if [ "$1 $2" = "agent wait" ]; then printf '{"status":"failed","stderr":"limit hit"}'; exit 1; fi; if [ "$1" = "agent" ]; then printf '{"job":"j1"}'; exit 0; fi; if [ "$1" = "regress" ] && [ "$2" = "check" ]; then echo nojson; exit 0; fi`;
    const commit = fakeSideTool(ws, `${agent}\n${INFO}`);
    const side = await makeSide(ctxOf(ws), { name: 'after', commit, agents: {} });
    expect(side.unknown).toBeNull();
    expect(await sideCheck(ctxOf(ws), side, { game: 'g', commit: 'c', out: '/o.json', checks: null, performance: false, proof: null })).toEqual({ error: 'ogw regress check exit 0: nojson' });
    expect(await sideAgent(ctxOf(ws), side, { role: 'content', game: 'g', input: '/i.md', seedRun: 'r:1' })).toEqual({ job: 'j1', status: 'failed', output: null, reason: 'agent job j1 failed: limit hit' });
    await removeSide(ctxOf(ws), side);
  });
});
