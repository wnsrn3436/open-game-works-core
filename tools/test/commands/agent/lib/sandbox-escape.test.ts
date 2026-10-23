// The macOS play and judge sandbox with the real sandbox-exec: no process outside the sandbox, no Docker daemon.
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import { claudeTempName } from '../../../../src/commands/agent/lib/cli-command.ts';
import { newAgentFolder, newTempFolder, osTempFolder } from '../../../../src/commands/agent/lib/files.ts';
import { cliToRun } from '../../../../src/commands/agent/lib/launch.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { newPrivateTempFolder, privateTempDir } from '../../../../src/lib/secret-files.ts';
import { OGW_KEYCHAIN_FILE, ogwKeychainFolder, linuxSecretsFolder } from '../../../../src/lib/secrets.ts';
import { run } from '../../../../src/lib/proc.ts';
import { jobWorkspace } from '../../job/helpers.ts';

/** An app bundle whose executable writes `<dir>/opened` when LaunchServices starts it; it shows no window or Dock icon. */
function markerApp(dir: string): string {
  const app = join(dir, 'marker.app');
  mkdirSync(join(app, 'Contents', 'MacOS'), { recursive: true });
  writeFileSync(
    join(app, 'Contents', 'Info.plist'),
    [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      '<key>CFBundleExecutable</key><string>marker</string>',
      `<key>CFBundleIdentifier</key><string>com.example.ogw-sandbox-test-${String(process.pid)}</string>`,
      '<key>CFBundlePackageType</key><string>APPL</string>',
      '<key>LSBackgroundOnly</key><true/>',
      '</dict></plist>',
    ].join('\n'),
  );
  const exe = join(app, 'Contents', 'MacOS', 'marker');
  writeFileSync(exe, `#!/bin/sh\ntouch "${join(dir, 'opened')}"\n`);
  chmodSync(exe, 0o755);
  return app;
}

/** Runs a command; asynchronous so that a server of this process can answer it. */
async function runFor(cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; out: string }> {
  const result = await run(cmd, args, { env, timeoutMs: 30_000 });
  return { code: result.code, out: `${result.stdout}${result.stderr}` };
}

function inside(profile: string, cmd: string, args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; out: string }> {
  return runFor('sandbox-exec', ['-f', profile, cmd, ...args], env);
}

describe.runIf(process.platform === 'darwin')('play and judge sandbox on macOS', () => {
  it('starts no process outside the sandbox, and a copied binary still finds LaunchServices blocked', async () => {
    const ws = jobWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const paths = ws;
    const { profileFolder } = await cliToRun(ctx, 'play', { cli: 'claude-code', model: 'm', effort: 'high' }, paths, null);
    const profile = join(profileFolder as string, 'sandbox.sb');
    const dir = await newTempFolder('ogw-escape-');
    const app = markerApp(dir);
    const opened = join(dir, 'opened');
    const label = `com.example.ogw-sandbox-test.${String(process.pid)}`;
    try {
      expect((await inside(profile, '/bin/launchctl', ['submit', '-l', label, '--', '/usr/bin/touch', opened])).code).not.toBe(0);
      expect((await inside(profile, '/usr/bin/open', ['-g', '-j', '-n', app])).code).not.toBe(0);
      expect((await inside(profile, '/bin/sh', ['-c', `open -g -j -n "${app}"`])).code).not.toBe(0);
      expect((await inside(profile, '/usr/bin/osascript', ['-e', 'return 1'])).code).not.toBe(0);
      // a copy of open is not /usr/bin/open: without the process-exec rule, the mach service rules still stop it
      const copied = join(dir, 'copied.sb');
      writeFileSync(copied, readFileSync(profile, 'utf8').split('\n').filter((line) => !line.startsWith('(deny process-exec')).join('\n'));
      const viaLaunchServices = await inside(copied, '/usr/bin/open', ['-g', '-j', '-n', app]);
      expect(viaLaunchServices.code).not.toBe(0);
      await sleep(2000);
      // the stopped launch can leave the app process outside the sandbox: a signal from inside cannot resume it
      for (const pid of spawnSync('pgrep', ['-f', dir], { encoding: 'utf8' }).stdout.split('\n').filter((line) => line !== '')) {
        expect((await inside(profile, '/bin/kill', ['-CONT', pid])).code).not.toBe(0);
      }
      await sleep(2000);
      expect(existsSync(opened)).toBe(false);
      // a signal to a process of the sandbox itself goes through
      expect((await inside(profile, '/bin/sh', ['-c', 'sleep 30 & kill $!'])).code).toBe(0);
    } finally {
      spawnSync('pkill', ['-KILL', '-f', dir], { timeout: 10_000 });
      spawnSync('launchctl', ['remove', label], { timeout: 10_000 });
      await rm(profileFolder as string, { recursive: true, force: true });
    }
  }, 60_000);

  it('writes only the agent folder, the temp folders, /dev and the agent CLI login: no git, shell or agent CLI config in home', async () => {
    const ws = jobWorkspace();
    const base = await newTempFolder('ogw-writes-');
    // home and TMPDIR of the agent: home is outside every temp folder the sandbox writes
    const home = join(base, 'home');
    const temp = join(base, 'tmp');
    for (const path of [join(home, '.claude'), join(home, '.codex'), join(home, 'Library', 'Keychains'), temp]) mkdirSync(path, { recursive: true });
    const folder = await newTempFolder('ogw-play-');
    const env = { ...ws.env, HOME: home, TMPDIR: temp, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const cli = await cliToRun(ctx, 'play', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(base, 'broker', 's'), folder);
    const blocked = [
      join(home, '.gitconfig'),
      join(home, '.config', 'git', 'config'),
      join(home, '.zshrc'),
      join(home, '.claude.json'),
      join(home, '.claude', 'settings.json'),
      join(home, '.claude', 'CLAUDE.md'),
      join(home, '.claude', 'hooks', 'h.sh'),
      join(home, '.claude', 'shell-snapshots', 's.sh'),
      join(home, '.codex', 'config.toml'),
      join(home, '.codex', 'AGENTS.md'),
      join(ws.harness, 'x'),
    ];
    const allowed = [
      join(folder, 'out.md'),
      join(temp, 't'),
      join(home, '.claude', '.credentials.json'),
      join(home, '.codex', 'auth.json'),
      join(home, 'Library', 'Keychains', 'k'),
      '/dev/null',
    ];
    const write = (path: string): string =>
      `(() => { try { fs.mkdirSync(${JSON.stringify(dirname(path))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(path)}, 'x'); return 'written'; } catch { return 'blocked'; } })()`;
    const script = `const fs = require('node:fs'); console.log([${[...blocked, ...allowed].map(write).join(', ')}].join(' '));`;
    const expected = `${[...blocked.map(() => 'blocked'), ...allowed.map(() => 'written')].join(' ')}\n`;
    try {
      expect(await inside(join(cli.profileFolder as string, 'sandbox.sb'), process.execPath, ['-e', script], cli.env)).toEqual({ code: 0, out: expected });
      for (const path of blocked) expect(existsSync(path)).toBe(false);
      // git runs and writes in the agent folder, not the global git config
      expect((await inside(join(cli.profileFolder as string, 'sandbox.sb'), 'git', ['-C', folder, 'init', '--quiet'], cli.env)).code).toBe(0);
      expect((await inside(join(cli.profileFolder as string, 'sandbox.sb'), 'git', ['config', '--global', 'core.fsmonitor', '/x'], cli.env)).code).not.toBe(0);
      expect(existsSync(join(home, '.gitconfig'))).toBe(false);
      // the commands the broker runs for the agent write no more than the agent
      const broker = await inside(join(cli.profileFolder as string, 'broker.sb'), process.execPath, ['-e', script], cli.env);
      expect(broker).toEqual({ code: 0, out: expected });
      for (const path of blocked) expect(existsSync(path)).toBe(false);
    } finally {
      await rm(cli.profileFolder as string, { recursive: true, force: true });
    }
  }, 60_000);

  it('neither reads nor writes the ogw keychain or the secret folder, in the agent or the broker sandbox, but keeps the login keychain of the agent CLI', async () => {
    const ws = jobWorkspace();
    const home = await newTempFolder('ogw-home-');
    const keychains = join(home, 'Library', 'Keychains');
    const ogwKeychain = join(ogwKeychainFolder({ HOME: home }), OGW_KEYCHAIN_FILE);
    mkdirSync(dirname(ogwKeychain), { recursive: true });
    writeFileSync(ogwKeychain, 'ogw secrets');
    writeFileSync(join(keychains, 'login.keychain-db'), 'login');
    const folder = await newTempFolder('ogw-play-');
    const env = { ...ws.env, HOME: home, CLAUDE_CONFIG_DIR: '', CODEX_HOME: '' };
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const cli = await cliToRun(ctx, 'play', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(home, 'broker', 's'), folder);
    const access = (path: string): string =>
      `(() => { const seen = []; try { seen.push(fs.readFileSync(${JSON.stringify(path)}, 'utf8')); } catch (e) { seen.push(e.code); } try { fs.appendFileSync(${JSON.stringify(path)}, '+'); seen.push('written'); } catch (e) { seen.push(e.code); } return seen.join(' '); })()`;
    const newKeychain = join(dirname(ogwKeychain), 'other.keychain-db');
    const folderSecret = join(linuxSecretsFolder(env), 'ogw%2Fharness%2Fx');
    mkdirSync(dirname(folderSecret), { recursive: true });
    writeFileSync(folderSecret, 'folder secret');
    const script = `const fs = require('node:fs'); console.log([${[ogwKeychain, newKeychain, folderSecret, join(keychains, 'login.keychain-db')].map(access).join(', ')}].join(' | '));`;
    try {
      for (const profile of ['sandbox.sb', 'broker.sb']) {
        const seen = await inside(join(cli.profileFolder as string, profile), process.execPath, ['-e', script], cli.env);
        expect(seen, profile).toEqual({ code: 0, out: `EPERM EPERM | ENOENT EPERM | EPERM EPERM | login${profile === 'broker.sb' ? '+' : ''} written\n` });
        // the security program finds no item there either
        const found = await inside(join(cli.profileFolder as string, profile), '/usr/bin/security', ['find-generic-password', '-s', 'ogw/harness/x', ogwKeychain], cli.env);
        expect(found.code, profile).not.toBe(0);
      }
      expect(readFileSync(ogwKeychain, 'utf8')).toBe('ogw secrets');
      expect(readFileSync(folderSecret, 'utf8')).toBe('folder secret');
      expect(existsSync(newKeychain)).toBe(false);
    } finally {
      await rm(cli.profileFolder as string, { recursive: true, force: true });
      await rm(folder, { recursive: true, force: true });
    }
  }, 60_000);

  it('neither reads nor writes the sandbox profiles of another agent or a tool review worktree, in the agent or the broker sandbox', async () => {
    const ws = jobWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const base = await newTempFolder('ogw-race-');
    const victim = await cliToRun(ctx, 'play', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(base, 'victim', 's'));
    const attacker = await cliToRun(ctx, 'judge', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(base, 'attacker', 's'));
    const victimProfile = join(victim.profileFolder as string, 'sandbox.sb');
    const profileText = readFileSync(victimProfile, 'utf8');
    // a tool review worktree, where the review agent starts outside the sandbox
    const review = await newPrivateTempFolder('ogw-tool-review-', ws.env);
    writeFileSync(join(review, 'CLAUDE.md'), 'harness');
    const temp = await privateTempDir(ws.env);
    const attempts = [
      ['write', victimProfile],
      ['write', join(victim.profileFolder as string, 'broker.sb')],
      ['read', victimProfile],
      ['write', join(review, 'CLAUDE.md')],
      ['write', join(review, '.claude', 'settings.json')],
      ['write', join(review, 'AGENTS.md')],
      ['write', join(temp, 'ogw-tool-review-planted', 'CLAUDE.md')],
      ['write', join(base, 'os-temp.txt')],
    ];
    const attempt = ([kind, path]: string[]): string =>
      kind === 'read'
        ? `(() => { try { fs.readFileSync(${JSON.stringify(path)}); return 'read'; } catch { return 'blocked'; } })()`
        : `(() => { try { fs.mkdirSync(${JSON.stringify(dirname(path as string))}, { recursive: true }); fs.writeFileSync(${JSON.stringify(path)}, 'planted'); return 'written'; } catch { return 'blocked'; } })()`;
    const script = `const fs = require('node:fs'); console.log([${attempts.map(attempt).join(', ')}].join(' '));`;
    // only the OS temp folder, which the sandboxes write by design, takes the write
    const expected = `${attempts.slice(0, -1).map(() => 'blocked').join(' ')} written\n`;
    try {
      // in the agent sandbox and in the broker sandbox
      for (const profile of ['sandbox.sb', 'broker.sb']) {
        expect(await inside(join(attacker.profileFolder as string, profile), process.execPath, ['-e', script], attacker.env)).toEqual({ code: 0, out: expected });
      }
      expect(readFileSync(victimProfile, 'utf8')).toBe(profileText);
      expect(readFileSync(join(review, 'CLAUDE.md'), 'utf8')).toBe('harness');
      expect(existsSync(join(review, '.claude'))).toBe(false);
      expect(existsSync(join(review, 'AGENTS.md'))).toBe(false);
      expect(existsSync(join(temp, 'ogw-tool-review-planted'))).toBe(false);
      // outside the sandbox the same script reaches every path
      expect((await runFor(process.execPath, ['-e', script])).out).toBe(`${attempts.map(([kind]) => (kind === 'read' ? 'read' : 'written')).join(' ')}\n`);
    } finally {
      for (const folder of [victim.profileFolder, attacker.profileFolder, review, join(temp, 'ogw-tool-review-planted')]) {
        if (folder !== null) await rm(folder, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('neither reads nor writes the folder of another play or judge agent, in the agent or the broker sandbox, but its own and the rest of the OS temp folder', async () => {
    const ws = jobWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const own = await newAgentFolder('play', ws.env);
    const other = await newAgentFolder('judge', ws.env);
    const temp = realpathSync(osTempFolder(ws.env));
    expect([dirname(own), dirname(other)]).toEqual([temp, temp]);
    mkdirSync(join(other, 'input'));
    const guide = join(other, 'input', 'play-guide-A.md');
    writeFileSync(guide, '# guide');
    writeFileSync(join(other, 'judge-1-1.md'), '# result');
    const base = await newTempFolder('ogw-neighbor-');
    const cli = await cliToRun(ctx, 'play', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(base, 'broker', 's'), own);
    // the agent CLI and its child processes put their temp files in the agent folder
    expect(cli.env.TMPDIR).toBe(join(own, 'tmp'));
    symlinkSync(other, join(own, 'link'));
    const attempts: [string, string][] = [
      ['read', guide],
      ['read', join(own, 'link', 'judge-1-1.md')],
      ['list', other],
      ['write', guide],
      ['write', join(other, 'judge-1-1.md')],
      ['write', join(other, 'captures', 'c.png')],
      ['write', join(temp, 'ogw-judge-planted', 'x')],
      ['write', join('/tmp', 'ogw-play-planted', 'x')],
      ['write', join(own, 'play-1-1.md')],
      ['read', join(own, 'play-1-1.md')],
      ['tmp', 'x'],
      ['write', join(base, 'os-temp.txt')],
    ];
    const attempt = ([kind, path]: [string, string]): string => {
      if (kind === 'read') return `(() => { try { fs.readFileSync(${JSON.stringify(path)}); return 'read'; } catch { return 'blocked'; } })()`;
      if (kind === 'list') return `(() => { try { fs.readdirSync(${JSON.stringify(path)}); return 'read'; } catch { return 'blocked'; } })()`;
      const target = kind === 'tmp' ? `require('node:path').join(require('node:os').tmpdir(), ${JSON.stringify(path)})` : JSON.stringify(path);
      return `(() => { try { const t = ${target}; fs.mkdirSync(require('node:path').dirname(t), { recursive: true }); fs.writeFileSync(t, 'planted'); return 'written'; } catch { return 'blocked'; } })()`;
    };
    const script = `const fs = require('node:fs'); console.log([${attempts.map(attempt).join(', ')}].join(' '));`;
    const expected = `${[...Array<string>(8).fill('blocked'), 'written', 'read', 'written', 'written'].join(' ')}\n`;
    try {
      for (const profile of ['sandbox.sb', 'broker.sb']) {
        expect(await inside(join(cli.profileFolder as string, profile), process.execPath, ['-e', script], cli.env)).toEqual({ code: 0, out: expected });
      }
      expect(readFileSync(guide, 'utf8')).toBe('# guide');
      expect(readFileSync(join(other, 'judge-1-1.md'), 'utf8')).toBe('# result');
      expect(existsSync(join(other, 'captures'))).toBe(false);
      expect(existsSync(join(temp, 'ogw-judge-planted'))).toBe(false);
      expect(existsSync('/tmp/ogw-play-planted')).toBe(false);
      expect(readFileSync(join(own, 'tmp', 'x'), 'utf8')).toBe('planted');
      // outside the sandbox the same script reaches every path
      const outside = await runFor(process.execPath, ['-e', script]);
      expect(outside.out).toBe(`${attempts.map(([kind]) => (kind === 'read' || kind === 'list' ? 'read' : 'written')).join(' ')}\n`);
    } finally {
      for (const folder of [cli.profileFolder, own, other, base, join(temp, 'ogw-judge-planted'), '/tmp/ogw-play-planted']) {
        if (folder !== null) await rm(folder, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('neither reads nor writes below the Claude Code temp root but in the folder of its own agent folder, in the agent or the broker sandbox', async () => {
    const ws = jobWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const own = await newAgentFolder('play', ws.env);
    const root = join('/tmp', `claude-${String(process.getuid?.())}`);
    const realRoot = join(realpathSync('/tmp'), basename(root));
    const other = join(realRoot, `ogw-test-other-${String(process.pid)}`);
    const planted = join(root, `ogw-test-planted-${String(process.pid)}`);
    const ownTemp = join(realRoot, claudeTempName(own));
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, 'task.output'), 'other session');
    const base = await newTempFolder('ogw-claude-temp-');
    const cli = await cliToRun(ctx, 'play', { cli: 'claude-code', model: 'm', effort: 'high' }, ws, null, join(base, 'broker', 's'), own);
    const attempts: [string, string][] = [
      ['read', join(other, 'task.output')],
      ['read', join(root, basename(other), 'task.output')],
      ['list', other],
      ['write', join(other, 'task.output')],
      ['write', join(planted, 'x')],
      ['write', join(ownTemp, 'session', 'tasks', 'a.output')],
      ['read', join(root, claudeTempName(own), 'session', 'tasks', 'a.output')],
    ];
    const attempt = ([kind, path]: [string, string]): string => {
      if (kind === 'read') return `(() => { try { fs.readFileSync(${JSON.stringify(path)}); return 'read'; } catch { return 'blocked'; } })()`;
      if (kind === 'list') return `(() => { try { fs.readdirSync(${JSON.stringify(path)}); return 'read'; } catch { return 'blocked'; } })()`;
      return `(() => { try { fs.mkdirSync(require('node:path').dirname(${JSON.stringify(path)}), { recursive: true }); fs.writeFileSync(${JSON.stringify(path)}, 'planted'); return 'written'; } catch { return 'blocked'; } })()`;
    };
    const script = `const fs = require('node:fs'); console.log([${attempts.map(attempt).join(', ')}].join(' '));`;
    try {
      for (const profile of ['sandbox.sb', 'broker.sb']) {
        expect(await inside(join(cli.profileFolder as string, profile), process.execPath, ['-e', script], cli.env)).toEqual({
          code: 0,
          out: `${[...Array<string>(5).fill('blocked'), 'written', 'read'].join(' ')}\n`,
        });
      }
      expect(readFileSync(join(other, 'task.output'), 'utf8')).toBe('other session');
      expect(existsSync(planted)).toBe(false);
    } finally {
      for (const folder of [cli.profileFolder, own, base, other, planted, ownTemp]) {
        if (folder !== null) await rm(folder, { recursive: true, force: true });
      }
    }
  }, 60_000);

  it('runs the agent CLI (node), git and ogw, and reads allowed files, but not the Docker socket or the harness git dir', async () => {
    const ws = jobWorkspace();
    const dir = await newTempFolder('ogw-docker-');
    const socket = join(dir, 'docker.sock');
    const server: Server = createServer((connection) => connection.end('docker'));
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    const env = { ...ws.env, DOCKER_HOST: `unix://${socket}`, DOCKER_CONTEXT: 'colima' };
    const ctx = createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const paths = ws;
    const cli = await cliToRun(ctx, 'judge', { cli: 'claude-code', model: 'm', effort: 'high' }, paths, null);
    const profile = join(cli.profileFolder as string, 'sandbox.sb');
    expect(cli.env.DOCKER_HOST).toBeUndefined();
    expect(cli.env.DOCKER_CONTEXT).toBeUndefined();
    const allowed = join(dir, 'guide.md');
    writeFileSync(allowed, '# guide');
    const connect = (target: string): string =>
      `await new Promise((r) => { const s = require('node:net').connect(${JSON.stringify(target)}); s.on('data', () => { console.log('connected'); s.destroy(); r(); }); s.on('error', (e) => { console.log('refused ' + e.code); r(); }); });`;
    const script = `(async () => { console.log(require('node:fs').readFileSync(${JSON.stringify(allowed)}, 'utf8')); ${connect(socket)} })()`;
    try {
      // outside the sandbox the fake daemon answers
      expect((await runFor(process.execPath, ['-e', script])).out).toBe('# guide\nconnected\n');
      expect(await inside(profile, process.execPath, ['-e', script], cli.env)).toEqual({ code: 0, out: '# guide\nrefused EPERM\n' });
      expect(await inside(profile, 'git', ['--version'], cli.env)).toMatchObject({ code: 0 });
      // the harness git common dir (jobs, instance records, secret files, hooks) is blocked
      const git = await inside(profile, 'git', ['-C', ws.harness, 'rev-parse', '--is-inside-work-tree'], cli.env);
      expect(git.code).not.toBe(0);
      const ogwBin = join(import.meta.dirname, '..', '..', '..', '..', 'bin', 'ogw');
      const ogw = await inside(profile, ogwBin, ['settings', 'get', 'harness', 'humanLanguage'], cli.env);
      expect(ogw.code).toBe(0);
    } finally {
      server.close();
      await rm(cli.profileFolder as string, { recursive: true, force: true });
    }
  }, 60_000);
});
