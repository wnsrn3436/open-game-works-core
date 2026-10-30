// Files with secret values (signing material, the deploy SSH key) and the temp folders of ogw go to owner-only folders
// the play and judge sandbox and the broker sandbox block.
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CLAUDE_BACKGROUND_WAIT_MS, cliToRun } from '../../src/commands/agent/lib/launch.ts';
import { openSsh } from '../../src/commands/deploy/lib/ssh.ts';
import { createContext } from '../../src/lib/command.ts';
import { commonDir } from '../../src/lib/git.ts';
import { cliEntry } from '../../src/lib/paths.ts';
import { newPrivateTempFolder, newSecretFolder, privateTempDir, privateTempPath, secretFilesDir } from '../../src/lib/secret-files.ts';
import { makeWorkspace, sh } from '../helpers/workspace.ts';

describe('secret files and temp folders', () => {
  it('makes owner-only folders in ogw-secret-files of the harness git common dir', async () => {
    const ws = makeWorkspace();
    const dir = await secretFilesDir(ws.env);
    expect(dir).toBe(join(await commonDir(ws.harness), 'ogw-secret-files'));
    const folder = await newSecretFolder('ogw-signing-', ws.env);
    expect(folder.startsWith(join(dir, 'ogw-signing-'))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
  });

  it('makes owner-only folders in ogw-temp of the harness git common dir', async () => {
    const ws = makeWorkspace();
    const dir = await privateTempDir(ws.env);
    expect(dir).toBe(join(await commonDir(ws.harness), 'ogw-temp'));
    const folder = await newPrivateTempFolder('ogw-check-', ws.env);
    expect(folder.startsWith(join(dir, 'ogw-check-'))).toBe(true);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(folder).mode & 0o777).toBe(0o700);
    const file = await privateTempPath('ogw-env', 'env-check.json', ws.env);
    expect(file).toBe(join(dir, 'ogw-env', 'env-check.json'));
    expect(statSync(join(dir, 'ogw-env')).mode & 0o777).toBe(0o700);
    // from a worktree of the harness repo, and with no git on PATH: the same folder
    const worktree = join(ws.root, 'harness-worktree');
    sh(ws.harness, 'git', ['worktree', 'add', '--quiet', '--detach', worktree]);
    expect(await privateTempDir({ ...ws.env, OGW_HARNESS_ROOT: worktree, PATH: '/nonexistent' })).toBe(dir);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('puts the play and judge sandbox profiles in an owner-only folder of ogw-temp', async () => {
    const ws = makeWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const cli = await cliToRun(ctx, 'judge', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(ws.root, 'b', 's'));
    try {
      const folder = cli.profileFolder as string;
      expect(folder.startsWith(join(await privateTempDir(ws.env), 'ogw-judge-sandbox-'))).toBe(true);
      expect(statSync(folder).mode & 0o777).toBe(0o700);
      expect(existsSync(join(folder, 'sandbox.sb')) && existsSync(join(folder, 'broker.sb'))).toBe(true);
    } finally {
      await rm(cli.profileFolder as string, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('gives the play and judge Claude Code the stored login token, and nothing to other CLIs or roles, and Claude Code of the other roles the background wait', async () => {
    const ws = makeWorkspace();
    // the shell of an agent that runs this test has the variable already
    delete ws.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS;
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const claude = { cli: 'claude-code' as const, model: 'm', effort: 'high' };
    const without = await cliToRun(ctx, 'judge', claude, ws, null, join(ws.root, 'b', 's'));
    await rm(without.profileFolder as string, { recursive: true, force: true });
    expect(without.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ 'ogw/harness/claude-code-oauth-token': 'long-lived-token' }));
    const stored = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const judge = await cliToRun(stored, 'judge', claude, ws, null, join(ws.root, 'b', 's'));
    const codex = await cliToRun(stored, 'play', { cli: 'codex', model: 'm', effort: 'high' }, ws, null, join(ws.root, 'c', 's'));
    try {
      expect(judge.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('long-lived-token');
      expect(codex.env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      expect((await cliToRun(stored, 'content', claude, ws, null)).env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
      // Claude Code in print mode waits an hour, not its default 10 minutes, for its background tasks (e.g. sub-agents);
      // play and judge keep the default
      const wait = String(CLAUDE_BACKGROUND_WAIT_MS);
      expect((await cliToRun(stored, 'content', claude, ws, null)).env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(wait);
      expect((await cliToRun(stored, 'resource', claude, ws, null)).env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBe(wait);
      expect(judge.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBeUndefined();
      expect(codex.env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBeUndefined();
      expect((await cliToRun(stored, 'content', { cli: 'codex', model: 'm', effort: 'high' }, ws, null)).env.CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS).toBeUndefined();
      // every agent's shell finds `ogw` by name: the harness tools/bin comes first on PATH
      const bin = resolve(dirname(cliEntry()), '..', 'bin');
      for (const env of [judge.env, codex.env, (await cliToRun(stored, 'content', claude, ws, null)).env]) expect(env.PATH?.split(delimiter)[0]).toBe(bin);
      expect(existsSync(join(bin, 'ogw'))).toBe(true);
    } finally {
      await rm(judge.profileFolder as string, { recursive: true, force: true });
      await rm(codex.profileFolder as string, { recursive: true, force: true });
    }
  });

  it('writes the deploy SSH key there and removes it on close', async () => {
    const ws = makeWorkspace();
    const bin = join(ws.root, 'bin');
    mkdirSync(bin);
    const seen = join(ws.root, 'ssh-args');
    writeFileSync(join(bin, 'ssh'), `#!/bin/sh\nkey="$2"\nprintf '%s\\n' "$key" > "${seen}"\ncat "$key" >> "${seen}"\n`);
    chmodSync(join(bin, 'ssh'), 0o755);
    const env = { ...ws.env, PATH: `${bin}:${process.env.PATH ?? ''}` };
    const session = await openSsh({ host: 'h', hostKey: 'ssh-ed25519 AAAA', user: 'u', dir: '/d', port: 22 }, 'PRIVATE', env);
    await session.execOk('true');
    const [keyFile, content] = readFileSync(seen, 'utf8').split('\n');
    expect(keyFile?.startsWith(join(await secretFilesDir(ws.env), 'ogw-ssh-'))).toBe(true);
    expect(content).toBe('PRIVATE');
    await session.close();
    expect(existsSync(keyFile as string)).toBe(false);
  });

  it.runIf(process.platform === 'darwin' || process.platform === 'linux')('is blocked in the play and judge agent sandbox and in the broker sandbox', async () => {
    const ws = makeWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const cli = await cliToRun(ctx, 'play', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(ws.root, 'b', 's'));
    try {
      for (const dir of [await secretFilesDir(ws.env), await privateTempDir(ws.env)]) {
        for (const profile of ['sandbox.sb', 'broker.sb']) {
          expect(readFileSync(join(cli.profileFolder as string, profile), 'utf8')).toMatch(new RegExp(`\\(deny file-read\\* file-write\\* [^\\n]*\\(subpath "${dir}"\\)`));
        }
      }
    } finally {
      await rm(cli.profileFolder as string, { recursive: true, force: true });
    }
  });
});
