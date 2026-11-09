// A caught error of `ogw agent` and `ogw agent merge`: only the expected error becomes a value; every other one fails.
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentHomeBlocked, dockerBlocked, sandboxed } from '../../../../src/commands/agent/lib/cli-command.ts';
import { commitInCheckout } from '../../../../src/commands/agent/lib/launch.ts';
import { orderIds } from '../../../../src/commands/agent/lib/merge.ts';
import { preparePlayInput } from '../../../../src/commands/agent/lib/play-input.ts';
import { sessionKept } from '../../../../src/commands/agent/lib/prepare.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { jobWorkspace } from '../../job/helpers.ts';

function folder(): string {
  return mkdtempSync(join(tmpdir(), 'ogw-caught-'));
}

describe('agent sandbox paths', () => {
  it('blocks an absent path as it is, and fails on a path that cannot be resolved', () => {
    const root = folder();
    const absent = join(root, 'absent');
    expect(sandboxed({ cmd: 'x', args: [] }, { folders: [absent], files: [] }, { platform: 'linux' }).args).toContain(absent);
    symlinkSync(join(root, 'b'), join(root, 'a'));
    symlinkSync(join(root, 'a'), join(root, 'b'));
    expect(() => sandboxed({ cmd: 'x', args: [] }, { folders: [join(root, 'a')], files: [] }, { platform: 'linux' })).toThrow(/ELOOP/);
  });

  it('reads an agent CLI config folder that is not there as empty, and fails on one that is no folder', () => {
    const root = folder();
    const env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
    expect(agentHomeBlocked(env, 'darwin').files).toContain(join(root, 'claude', 'history.jsonl'));
    writeFileSync(join(root, 'claude'), 'a file');
    expect(() => agentHomeBlocked(env, 'darwin')).toThrow(/ENOTDIR/);
  });

  it('blocks the socket of each Docker context, skips an entry that has no context file, and fails on a context file that is not JSON', () => {
    const root = folder();
    const meta = join(root, 'docker', 'contexts', 'meta');
    mkdirSync(join(meta, 'good'), { recursive: true });
    mkdirSync(join(meta, 'empty'));
    writeFileSync(join(meta, '.DS_Store'), '');
    writeFileSync(join(meta, 'good', 'meta.json'), JSON.stringify({ Endpoints: { docker: { Host: 'unix:///run/good.sock' } } }));
    const env = { HOME: root, DOCKER_CONFIG: join(root, 'docker') };
    expect(dockerBlocked(env).sockets).toContain('/run/good.sock');
    mkdirSync(join(meta, 'bad'));
    writeFileSync(join(meta, 'bad', 'meta.json'), '{ not json');
    expect(() => dockerBlocked(env)).toThrow(`${join(meta, 'bad', 'meta.json')} is not JSON`);
    writeFileSync(join(meta, 'bad', 'meta.json'), '{}');
    mkdirSync(join(meta, 'unreadable'));
    mkdirSync(join(meta, 'unreadable', 'meta.json'));
    expect(() => dockerBlocked(env)).toThrow(/EISDIR/);
  });
});

describe('agent files', () => {
  it('commits nothing for a folder in no checkout, and fails when git cannot run', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'f.md'), 'x');
    await expect(commitInCheckout(dir, [join(dir, 'f.md')], 'm', { env: process.env, noVerify: true })).resolves.toBeUndefined();
    await expect(commitInCheckout(dir, [join(dir, 'f.md')], 'm', { env: { ...process.env, PATH: join(dir, 'no-bin') }, noVerify: true })).rejects.toThrow('cannot run git');
  });

  it('finds no kept session without the session folder of the agent CLI, and fails on one that cannot be read', async () => {
    const root = folder();
    const env = { HOME: root, CLAUDE_CONFIG_DIR: join(root, 'claude'), CODEX_HOME: join(root, 'codex') };
    expect(await sessionKept('claude-code', env, 's1')).toBe(false);
    expect(await sessionKept('codex', env, 's1')).toBe(false);
    mkdirSync(join(root, 'claude'));
    writeFileSync(join(root, 'claude', 'projects'), 'a file');
    await expect(sessionKept('claude-code', env, 's1')).rejects.toMatchObject({ code: 'ENOTDIR' });
    mkdirSync(join(root, 'codex'));
    writeFileSync(join(root, 'codex', 'sessions'), 'a file');
    await expect(sessionKept('codex', env, 's1')).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('says a play input is not JSON only for a text that is not JSON; an input that cannot be read fails with its error', async () => {
    const dir = folder();
    writeFileSync(join(dir, 'input.json'), 'not json');
    await expect(preparePlayInput('play', join(dir, 'input.json'), join(dir, 'out'))).rejects.toThrow(`play input is not JSON: ${join(dir, 'input.json')}`);
    mkdirSync(join(dir, 'folder.json'));
    await expect(preparePlayInput('play', join(dir, 'folder.json'), join(dir, 'out'))).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('agent merge order', () => {
  it('orders an id that is no agent job as one without modules, and fails on a job record that cannot be read', async () => {
    const ws = jobWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await orderIds(ctx, ['nojob'])).toEqual({ ids: ['nojob'], unordered: [] });
    mkdirSync(join(ws.jobs, 'broken.json'));
    await expect(orderIds(ctx, ['broken'])).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
