import { chmodSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  agentCliCommand,
  agentHomeBlocked,
  agentLoginWrites,
  agentSettings,
  claudeTempName,
  defaultConfigFolder,
  dockerBlocked,
  localSocketsBlocked,
  macosProfile,
  makeBlocked,
  resolvedPath,
  SANDBOX_DROPPED_ENV,
  sandboxed,
  userServicesBlocked,
  withoutSessionFiles,
} from '../../../../src/commands/agent/lib/cli-command.ts';
import { move, newTempFolder } from '../../../../src/commands/agent/lib/files.ts';
import { runLogPath } from '../../../../src/lib/agentctx.ts';
import { extensionOf, withoutExtension } from '../../../../src/lib/paths.ts';
import { mergeOrder, topologicalOrder } from '../../../../src/commands/agent/lib/order.ts';
import { preparePlayInput } from '../../../../src/commands/agent/lib/play-input.ts';
import { absoluteLinks, buildPrompt, markdownSection, paramsBlock } from '../../../../src/commands/agent/lib/prompt.ts';
import { coreCommand } from '../../../../src/commands/agent/lib/prepare.ts';
import type { HarnessSettings } from '../../../../src/lib/settings.ts';
import { makeGame, makeWorkspace, sh } from '../../../helpers/workspace.ts';
import { commitInCheckout } from '../../../../src/commands/agent/lib/launch.ts';
import { withLock } from '../../../../src/lib/lock.ts';
import { byteCompare } from '../../../../src/lib/order.ts';
import { escapeRegExp } from '../../../../src/lib/regexp.ts';

describe('prompt', () => {
  const doc = '# t\n\n## a\n\none\n```\n## not a heading\n```\n### sub\n\n## b\ntwo\n';

  it('cuts a section up to the next ## heading outside code fences', () => {
    expect(markdownSection(doc, 'a')).toBe('## a\n\none\n```\n## not a heading\n```\n### sub\n\n');
    expect(markdownSection(doc, 'b')).toBe('## b\ntwo\n\n');
    expect(markdownSection(doc, 'c')).toBeNull();
  });

  it('makes ../ link targets absolute', () => {
    expect(absoluteLinks('[x](../skills/a.md) [y](b.md) [z](../AGENTS.md)', '/h')).toBe('[x](/h/skills/a.md) [y](b.md) [z](/h/AGENTS.md)');
  });

  it('writes the values block, leaving out run and iteration when null', () => {
    expect(paramsBlock({ input: '/i', output: '/o', run: 'r1', iteration: 2 })).toBe('## ogw agent\n\n- input: /i\n- output: /o\n- run: r1\n- iteration: 2\n');
    expect(paramsBlock({ input: '/i', output: '/o', run: null, iteration: null })).toBe('## ogw agent\n\n- input: /i\n- output: /o\n');
  });

  it('puts the AGENTS.md sections in order before the role definition, but not for play and judge', async () => {
    const ws = makeWorkspace();
    const params = { input: '/i', output: '/o', run: null, iteration: null };
    const content = await buildPrompt(ws.harness, 'content', params);
    const agentsMd = readFileSync(join(ws.harness, 'AGENTS.md'), 'utf8');
    const sections = ['purpose', 'terms', 'repo', 'layer', 'environment', 'rules'].map((name) => markdownSection(agentsMd, name) as string);
    const definition = absoluteLinks(readFileSync(join(ws.harness, 'agents', 'content.md'), 'utf8'), ws.harness);
    expect(content).toBe([...sections, definition, paramsBlock(params)].join('\n'));
    expect(content).not.toContain('](../');
    const play = await buildPrompt(ws.harness, 'play', params);
    expect(play.startsWith('---\nname: play')).toBe(true);
    expect(play).not.toContain('## purpose');
  });

  it('fails when AGENTS.md misses a section', async () => {
    const ws = makeWorkspace();
    const path = join(ws.harness, 'AGENTS.md');
    writeFileSync(path, readFileSync(path, 'utf8').replace('## layer\n', '## layers\n'));
    await expect(buildPrompt(ws.harness, 'core', { input: '/i', output: '/o', run: null, iteration: null })).rejects.toThrow('AGENTS.md has no section ## layer');
  });
});

describe('agent CLI', () => {
  const settings = { agents: { content: { model: 'm1', effort: 'high' }, core: { cli: 'codex', model: 'm2', effort: 'low' } } } as unknown as HarnessSettings;

  it('runs Claude Code without approvals with model and effort', () => {
    expect(agentCliCommand(agentSettings(settings, 'content'))).toEqual({
      cmd: 'claude',
      args: ['-p', '--model', 'm1', '--effort', 'high', '--permission-mode', 'bypassPermissions'],
    });
  });

  it('runs Codex without approvals and git repo check', () => {
    expect(agentCliCommand(agentSettings(settings, 'core'))).toEqual({
      cmd: 'codex',
      args: ['exec', '--model', 'm2', '-c', 'model_reasoning_effort="low"', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '-'],
    });
  });

  it('fails without settings for the role', () => {
    expect(() => agentSettings(settings, 'play')).toThrow('harness settings agents.play is missing');
  });

  it('wraps a command in the OS sandbox', () => {
    const command = { cmd: 'claude', args: ['-p'] };
    const blocked = { folders: ['/nowhere/games'], files: ['/nowhere/j.stdout'] };
    const mac = sandboxed(command, blocked, { platform: 'darwin' });
    expect(mac.cmd).toBe('sandbox-exec');
    expect(mac.args.slice(2)).toEqual(['claude', '-p']);
    expect(mac.args[1]).toBe(macosProfile(blocked));
    expect(sandboxed(command, blocked, { platform: 'darwin', macosProfileFile: '/t/sb' }).args).toEqual(['-f', '/t/sb', 'claude', '-p']);
    expect(macosProfile({ folders: ['/nowhere/a "b"'], files: ['/nowhere/c'] })).toBe(
      [
        '(version 1)',
        '(allow default)',
        '(deny file-read* file-write* (subpath "/nowhere/a \\"b\\"") (literal "/nowhere/c"))',
        // no process outside the sandbox: launchd jobs, LaunchServices, AppleEvents, a signal that resumes a stopped one
        '(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
        '(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name "com.apple.coreservicesd"))',
        '(deny appleevent-send)',
        '(deny signal)',
        '(allow signal (target same-sandbox))',
        '',
      ].join('\n'),
    );
    // a new PID namespace with its own /proc: no other process's /proc/<pid>/root, cmdline or environ
    expect(sandboxed(command, { folders: ['/g', '/w'], files: ['/f'] }, { platform: 'linux' })).toEqual({
      cmd: 'bwrap',
      args: ['--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--tmpfs', '/g', '--tmpfs', '/w', '--ro-bind', '/dev/null', '/f', '--die-with-parent', '--', 'claude', '-p'],
    });
    expect(() => sandboxed(command, { folders: [], files: [] }, { platform: 'win32' })).toThrow('the sandbox runs only on macOS and Linux, not on win32');
  });

  it('makes the blocked paths that do not exist before the sandbox starts, and mounts each at its real path', async () => {
    const dir = await newTempFolder('ogw-blocked-');
    const real = join(dir, 'real-home');
    mkdirSync(real);
    writeFileSync(join(real, 'history.jsonl'), 'kept');
    const link = join(dir, 'link-home');
    symlinkSync(real, link);
    const blocked = { folders: [join(link, 'todos'), join(link, 'plans')], files: [join(link, 'history.jsonl'), join(link, 'log', 'x.log')] };
    // macOS makes nothing: its rules are at the real path of the deepest existing folder
    makeBlocked(blocked, 'darwin');
    expect(readdirSync(real)).toEqual(['history.jsonl']);
    const before = macosProfile(blocked);
    for (const path of [join(real, 'todos'), join(real, 'plans')]) expect(before).toContain(`(subpath "${path}")`);
    expect(before).toContain(`(literal "${join(real, 'log', 'x.log')}")`);
    expect(resolvedPath(join(link, 'a', 'b'))).toBe(join(real, 'a', 'b'));
    makeBlocked(blocked, 'linux');
    expect(readdirSync(real).sort()).toEqual(['history.jsonl', 'log', 'plans', 'todos']);
    expect(readFileSync(join(real, 'history.jsonl'), 'utf8')).toBe('kept');
    expect(readFileSync(join(real, 'log', 'x.log'), 'utf8')).toBe('');
    // a folder made by a process outside the sandbox after it started is under a mount made at start
    expect(sandboxed({ cmd: 'claude', args: [] }, blocked, { platform: 'linux' }).args).toEqual([
      '--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc',
      '--tmpfs', join(real, 'todos'), '--tmpfs', join(real, 'plans'),
      '--ro-bind', '/dev/null', join(real, 'history.jsonl'), '--ro-bind', '/dev/null', join(real, 'log', 'x.log'),
      '--die-with-parent', '--', 'claude',
    ]);
    const profile = macosProfile(blocked);
    for (const path of [join(link, 'todos'), join(real, 'todos'), join(real, 'plans')]) expect(profile).toContain(`(subpath "${path}")`);
    expect(profile).toContain(`(literal "${join(real, 'log', 'x.log')}")`);
  });

  it('finds the default config folders and blocks only their session stores, not the login', async () => {
    expect(defaultConfigFolder('claude-code', { HOME: '/h' })).toBe('/h/.claude');
    expect(defaultConfigFolder('codex', { HOME: '/h' })).toBe('/h/.codex');
    expect(defaultConfigFolder('claude-code', { HOME: '/h', CLAUDE_CONFIG_DIR: '/c' })).toBe('/c');
    expect(defaultConfigFolder('codex', { HOME: '/h', CODEX_HOME: '/x' })).toBe('/x');
    expect(agentHomeBlocked({ HOME: '/h' })).toEqual({
      folders: ['/h/.claude/projects', '/h/.claude/file-history', '/h/.claude/todos', '/h/.claude/plans', '/h/.claude/debug', '/h/.codex/sessions', '/h/.codex/archived_sessions', '/h/.codex/log'],
      files: ['/h/.claude/history.jsonl', '/h/.codex/history.jsonl'],
    });
    const dir = await newTempFolder('ogw-test-config-');
    mkdirSync(join(dir, 'codex'));
    for (const name of ['auth.json', 'config.toml', 'state_5.sqlite', 'state_5.sqlite-wal', 'memories_1.sqlite', 'logs_2.sqlite-shm', 'goals_1.sqlite']) {
      writeFileSync(join(dir, 'codex', name), '');
    }
    const blocked = agentHomeBlocked({ HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') });
    expect(blocked.folders).toContain(join(dir, 'claude', 'projects'));
    expect(blocked.files.filter((f) => f.startsWith(join(dir, 'codex'))).sort()).toEqual(
      [
        'history.jsonl',
        'logs_2.sqlite-shm',
        // a DB file present at launch blocks its `-wal` and `-shm` files even when they do not exist yet
        'memories_1.sqlite',
        'memories_1.sqlite-shm',
        'memories_1.sqlite-wal',
        'state_5.sqlite',
        'state_5.sqlite-shm',
        'state_5.sqlite-wal',
      ].map((n) => join(dir, 'codex', n)),
    );
    expect(new Set(blocked.files).size).toBe(blocked.files.length);
    // the login and the settings stay readable: the agent CLI keeps the user's login
    const all = [...blocked.folders, ...blocked.files];
    for (const kept of [join(dir, 'codex', 'auth.json'), join(dir, 'claude', '.credentials.json'), join(dir, '.claude.json'), join(dir, 'claude')]) {
      expect(all.some((path) => kept === path || kept.startsWith(`${path}/`))).toBe(false);
    }
  });

  it('creates no file in the Codex config folder; on Linux hides the whole folder and keeps the login and config', async () => {
    const dir = await newTempFolder('ogw-test-codex-');
    const codex = join(dir, 'codex');
    mkdirSync(codex);
    for (const name of ['auth.json', 'config.toml', 'state_5.sqlite']) writeFileSync(join(codex, name), '');
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: codex };
    const mac = agentHomeBlocked(env, 'darwin');
    makeBlocked(mac, 'darwin');
    // the -wal and -shm rules need no file: nothing is made in the user's config folder
    expect(readdirSync(codex).sort()).toEqual(['auth.json', 'config.toml', 'state_5.sqlite']);
    expect(macosProfile(mac)).toContain(`(literal "${join(codex, 'state_5.sqlite-wal')}")`);
    const linux = agentHomeBlocked(env, 'linux');
    expect(linux.hidden).toEqual([{ folder: codex, keep: [join(codex, 'auth.json'), join(codex, 'config.toml')] }]);
    expect([...linux.folders, ...linux.files].some((path) => path.startsWith(codex))).toBe(false);
    makeBlocked(linux, 'linux');
    expect(readdirSync(codex).sort()).toEqual(['auth.json', 'config.toml', 'state_5.sqlite']);
    const args = sandboxed({ cmd: 'codex', args: [] }, linux, { platform: 'linux' }).args;
    const at = args.indexOf(codex);
    expect(args.slice(at - 1, at + 7)).toEqual([
      '--tmpfs', codex,
      '--ro-bind', join(codex, 'auth.json'), join(codex, 'auth.json'),
      '--ro-bind', join(codex, 'config.toml'), join(codex, 'config.toml'),
    ]);
    // a missing file is not bound back, and a missing Codex config folder is made empty
    rmSync(join(codex, 'config.toml'));
    expect(sandboxed({ cmd: 'codex', args: [] }, linux, { platform: 'linux' }).args).not.toContain(join(codex, 'config.toml'));
    const fresh = agentHomeBlocked({ ...env, CODEX_HOME: join(dir, 'none') }, 'linux');
    makeBlocked(fresh, 'linux');
    expect(readdirSync(join(dir, 'none'))).toEqual([]);
  });

  it('blocks the Docker daemon sockets: default paths, DOCKER_HOST, Docker contexts, Colima and OrbStack', async () => {
    const dir = await newTempFolder('ogw-test-docker-');
    const config = join(dir, 'docker-config');
    mkdirSync(join(config, 'contexts', 'meta', 'abc'), { recursive: true });
    writeFileSync(join(config, 'contexts', 'meta', 'abc', 'meta.json'), JSON.stringify({ Name: 'colima', Endpoints: { docker: { Host: `unix://${join(dir, 'ctx.sock')}` } } }));
    mkdirSync(join(config, 'contexts', 'meta', 'tcp'), { recursive: true });
    writeFileSync(join(config, 'contexts', 'meta', 'tcp', 'meta.json'), JSON.stringify({ Endpoints: { docker: { Host: 'tcp://127.0.0.1:2375' } } }));
    const docker = dockerBlocked({ HOME: dir, DOCKER_CONFIG: config, DOCKER_HOST: `unix://${join(dir, 'host.sock')}`, XDG_RUNTIME_DIR: join(dir, 'xdg') });
    expect(docker.sockets).toEqual(['/var/run/docker.sock', '/run/docker.sock', join(dir, 'xdg', 'docker.sock'), join(dir, 'host.sock'), join(dir, 'ctx.sock')]);
    expect(docker.socketFolders).toEqual([join(config, 'run'), join(dir, '.docker', 'run'), join(dir, '.colima'), join(dir, '.orbstack')]);
    expect(dockerBlocked({ HOME: dir, DOCKER_HOST: 'tcp://h:1' }).sockets).toEqual(['/var/run/docker.sock', '/run/docker.sock']);
    const blocked = { folders: [], files: [], ...docker };
    const profile = macosProfile(blocked);
    expect(profile).toContain(`(literal "${join(dir, 'host.sock')}")`);
    expect(profile).toContain(`(subpath "${join(dir, '.colima')}")`);
    expect(profile).toMatch(/\(deny network-outbound \(remote unix-socket \(path-literal "\/var\/run\/docker\.sock"\)\) /);
    expect(profile).toContain(`(remote unix-socket (path-literal "${join(dir, 'ctx.sock')}"))`);
    expect(profile).toContain(`(remote unix-socket (subpath "${join(dir, '.orbstack')}")))`);
    // Linux: only what exists, so nothing is made on the host
    mkdirSync(join(dir, '.colima'));
    writeFileSync(join(dir, 'host.sock'), '');
    const args = sandboxed({ cmd: 'claude', args: [] }, blocked, { platform: 'linux' }).args;
    expect(args).toContain(join(dir, '.colima'));
    expect(args).not.toContain(join(dir, '.orbstack'));
    expect(args).not.toContain(join(dir, 'ctx.sock'));
    const at = args.indexOf(join(dir, 'host.sock'));
    expect(args.slice(at - 2, at + 1)).toEqual(['--ro-bind', '/dev/null', join(dir, 'host.sock')]);
  });

  it('blocks writing read-only folders, keeps excepted ones open, and on macOS the local network and other unix sockets', () => {
    const blocked = {
      folders: ['/h/.git', '/h/.git/ogw-jobs'],
      files: [],
      exceptFolders: ['/h/.git/ogw-jobs/brokers/j1'],
      readOnly: ['/h', '/c'],
      writable: ['/h/.git/ogw-jobs'],
      localNetwork: { allowSockets: ['/h/.git/ogw-jobs/brokers/j1/s', '/var/run/mDNSResponder'] },
    };
    const profile = macosProfile(blocked).split('\n');
    // a later rule wins over an earlier one
    expect(profile.slice(2, 8)).toEqual([
      '(deny file-write* (subpath "/h") (subpath "/c"))',
      '(allow file-write* (subpath "/h/.git/ogw-jobs"))',
      '(deny file-read* file-write* (subpath "/h/.git") (subpath "/h/.git/ogw-jobs"))',
      '(allow file-read* file-write* (subpath "/h/.git/ogw-jobs/brokers/j1"))',
      // `localhost` is every address of this host; DNS goes through the mDNSResponder socket
      '(deny network-outbound (remote ip "localhost:*") (remote unix-socket (subpath "/")))',
      '(allow network-outbound (remote unix-socket (path-literal "/h/.git/ogw-jobs/brokers/j1/s")) (remote unix-socket (path-literal "/var/run/mDNSResponder")) (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))',
    ]);
    expect(macosProfile({ folders: [], files: [] })).not.toContain('network-outbound');
    // Linux: read-only binds, writable binds, the blocks, then the excepted folders bound back; the network stays
    expect(sandboxed({ cmd: 'claude', args: [] }, blocked, { platform: 'linux' }).args).toEqual([
      '--dev-bind', '/', '/', '--unshare-pid', '--proc', '/proc',
      '--ro-bind', '/h', '/h', '--ro-bind', '/c', '/c', '--bind', '/h/.git/ogw-jobs', '/h/.git/ogw-jobs',
      '--tmpfs', '/h/.git', '--tmpfs', '/h/.git/ogw-jobs',
      '--bind', '/h/.git/ogw-jobs/brokers/j1', '/h/.git/ogw-jobs/brokers/j1',
      '--die-with-parent', '--', 'claude',
    ]);
    // the broker sandbox keeps the host PID namespace, so the background jobs a command starts outlive it
    expect(sandboxed({ cmd: 'node', args: [] }, { folders: ['/g'], files: [] }, { platform: 'linux', pidNamespace: false }).args).toEqual([
      '--dev-bind', '/', '/', '--tmpfs', '/g', '--die-with-parent', '--', 'node',
    ]);
  });

  it('writes only the allowed folders and files: macOS denies every other write first, Linux binds / read-only', async () => {
    const dir = await newTempFolder('ogw-test-writes-');
    for (const name of ['agent', 'tmp', 'games', 'codex', 'claude']) mkdirSync(join(dir, name));
    for (const name of ['codex/auth.json', 'codex/config.toml', 'claude/.credentials.json']) writeFileSync(join(dir, name), '');
    const env = { HOME: dir, CLAUDE_CONFIG_DIR: join(dir, 'claude'), CODEX_HOME: join(dir, 'codex') };
    expect(agentLoginWrites(env, 'darwin')).toEqual({
      folders: [join(dir, 'Library', 'Keychains')],
      files: [join(dir, 'claude', '.credentials.json'), join(dir, 'codex', 'auth.json')],
    });
    expect(agentLoginWrites(env, 'linux').folders).toEqual([]);
    const login = agentLoginWrites(env, 'linux');
    const allowedWrites = { folders: [join(dir, 'agent'), join(dir, 'tmp'), join(dir, 'missing')], files: login.files };
    const blocked = { folders: [join(dir, 'games')], files: [], hidden: agentHomeBlocked(env, 'linux').hidden ?? [], allowedWrites };
    const profile = macosProfile(blocked).split('\n');
    // every write is denied first; the rules after it still block inside the allowed folders
    expect(profile.slice(1, 5)).toEqual([
      '(allow default)',
      '(deny file-write*)',
      `(allow file-write* (subpath "/dev") (subpath "${join(dir, 'agent')}") (subpath "${join(dir, 'tmp')}") (subpath "${join(dir, 'missing')}") (literal "${join(dir, 'claude', '.credentials.json')}") (literal "${join(dir, 'codex', 'auth.json')}"))`,
      `(deny file-read* file-write* (subpath "${join(dir, 'games')}"))`,
    ]);
    expect(macosProfile({ folders: [], files: [] })).not.toContain('(deny file-write*)');
    // Linux: `/` read-only, `/dev` as it is, the existing allowed folders writable before the blocks, and the login
    // files writable after the hidden Codex folder that keeps them read-only
    const codex = join(dir, 'codex');
    expect(sandboxed({ cmd: 'claude', args: [] }, blocked, { platform: 'linux' }).args).toEqual([
      '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--unshare-pid', '--proc', '/proc',
      '--bind', join(dir, 'agent'), join(dir, 'agent'), '--bind', join(dir, 'tmp'), join(dir, 'tmp'),
      '--tmpfs', join(dir, 'games'),
      '--tmpfs', codex, '--ro-bind', join(codex, 'auth.json'), join(codex, 'auth.json'), '--ro-bind', join(codex, 'config.toml'), join(codex, 'config.toml'),
      '--bind', join(dir, 'claude', '.credentials.json'), join(dir, 'claude', '.credentials.json'), '--bind', join(codex, 'auth.json'), join(codex, 'auth.json'),
      '--die-with-parent', '--', 'claude',
    ]);
  });

  it('blocks the folders of other play and judge agents: macOS by name under the temp folders, Linux with a tmpfs over them; the own folder stays', async () => {
    const dir = await newTempFolder('ogw-test-agents-');
    const temp = join(dir, 'T');
    const nested = join(temp, 'inner');
    const own = join(temp, 'ogw-play-a');
    const keys = join(dir, 'keys');
    const games = join(dir, 'games');
    for (const folder of [nested, own, keys, games]) mkdirSync(folder, { recursive: true });
    const missing = join(dir, 'missing');
    const prefixes = ['ogw-play-', 'ogw-judge-'];
    const blocked = {
      folders: [games],
      files: [],
      allowedWrites: { folders: [own, nested, temp, keys], files: [] },
      agentFolders: { temps: [nested, temp, missing], prefixes, own },
    };
    expect(escapeRegExp('a.b+c/(d)')).toBe('a\\.b\\+c/\\(d\\)');
    const regex = (folder: string): string => `(regex "^${escapeRegExp(folder).replaceAll('\\', '\\\\')}/(ogw-play-|ogw-judge-)")`;
    const profile = macosProfile(blocked).split('\n');
    const deny = profile.indexOf(`(deny file-read* file-write* ${regex(nested)} ${regex(temp)} ${regex(missing)})`);
    const allow = profile.indexOf(`(allow file-read* file-write* (subpath "${own}"))`);
    const gamesDeny = profile.indexOf(`(deny file-read* file-write* (subpath "${games}"))`);
    // the own folder is allowed after the name rule and before the other blocks, which still win inside it
    expect(deny).toBeGreaterThan(0);
    expect(allow).toBe(deny + 1);
    expect(gamesDeny).toBe(allow + 1);
    expect(macosProfile({ ...blocked, agentFolders: { temps: [temp], prefixes, own: null } })).not.toContain('(allow file-read* file-write* (subpath');
    // Linux: each existing temp folder an empty tmpfs, a parent first, then the own folder bound back, then the
    // other allowed folders; the temp folders are not bound writable
    const head = ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--unshare-pid', '--proc', '/proc'];
    const tail = ['--tmpfs', games, '--die-with-parent', '--', 'claude'];
    expect(sandboxed({ cmd: 'claude', args: [] }, blocked, { platform: 'linux' }).args).toEqual([
      ...head,
      '--tmpfs', temp, '--tmpfs', nested,
      '--bind', own, own,
      '--bind', keys, keys,
      ...tail,
    ]);
    expect(sandboxed({ cmd: 'claude', args: [] }, { ...blocked, agentFolders: { temps: [temp], prefixes, own: null } }, { platform: 'linux' }).args).toEqual([
      ...head,
      '--tmpfs', temp,
      '--bind', own, own, '--bind', nested, nested, '--bind', keys, keys,
      ...tail,
    ]);
  });

  it('macOS: blocks below the Claude Code temp root but the folder of the own folder, named after its given and real path', async () => {
    expect(claudeTempName('/private/var/folders/dv/x_y/T/ogw-play-ab.c')).toBe('-private-var-folders-dv-x-y-T-ogw-play-ab-c');
    const dir = await newTempFolder('ogw-test-claude-');
    const realTmp = join(dir, 'private-tmp');
    const own = join(dir, 'T', 'ogw-play-a.b');
    const games = join(dir, 'games');
    for (const folder of [realTmp, own, games]) mkdirSync(folder, { recursive: true });
    symlinkSync(realTmp, join(dir, 'tmp'));
    symlinkSync(join(dir, 'T'), join(dir, 'TL'));
    const given = join(dir, 'TL', 'ogw-play-a.b');
    const root = join(dir, 'tmp', 'claude-501');
    const realRoot = join(realTmp, 'claude-501');
    const blocked = {
      folders: [games],
      files: [],
      agentFolders: { temps: [join(dir, 'T')], prefixes: ['ogw-play-'], own: given, claudeTemp: root },
    };
    const sb = (text: string): string => text.replaceAll('\\', '\\\\');
    const profile = macosProfile(blocked).split('\n');
    const deny = profile.indexOf(`(deny file-read* file-write* (regex "^${sb(escapeRegExp(root))}/") (regex "^${sb(escapeRegExp(realRoot))}/"))`);
    const names = [claudeTempName(given), claudeTempName(own)];
    expect(names[0]).not.toBe(names[1]);
    const allowed = [root, realRoot].flatMap((r) => names.map((name) => `(subpath "${join(r, name)}")`));
    // after the rules of the other agent folders and before the other blocks, which still win inside the allowed folder
    expect(profile[deny - 1]).toMatch(/^\(allow file-read\* file-write\* \(subpath /);
    expect(profile[deny + 1]).toBe(`(allow file-read* file-write* ${allowed.join(' ')})`);
    expect(profile[deny + 2]).toBe(`(deny file-read* file-write* (subpath "${games}"))`);
    const withoutOwn = macosProfile({ ...blocked, agentFolders: { ...blocked.agentFolders, own: null } }).split('\n');
    expect(withoutOwn).toContain(profile[deny]);
    expect(withoutOwn.filter((line) => line.includes('claude-501'))).toEqual([profile[deny]]);
    expect(macosProfile({ ...blocked, agentFolders: { temps: [], prefixes: [], own: given } })).not.toContain('claude-501');
  });

  it('blocks the SSH agent and tmux sockets and does not pass their variables', () => {
    expect(localSocketsBlocked({ SSH_AUTH_SOCK: '/s/agent.sock', TMUX: '/t/tmux-7/default,123,0', TMUX_TMPDIR: '/t' }, 7)).toEqual({
      sockets: ['/s/agent.sock', '/t/tmux-7/default'],
      socketFolders: ['/t/tmux-7', '/tmp/tmux-7'],
    });
    expect(localSocketsBlocked({}, 7)).toEqual({ sockets: [], socketFolders: ['/tmp/tmux-7'] });
    for (const name of ['SSH_AUTH_SOCK', 'TMUX', 'TMUX_PANE', 'DOCKER_HOST', 'DOCKER_CONTEXT']) expect(SANDBOX_DROPPED_ENV).toContain(name);
  });

  it('blocks on Linux the user services (runtime folders, D-Bus buses) and does not pass their variables', async () => {
    const dir = await newTempFolder('ogw-runtime-');
    const runtime = join(dir, 'run-user-7');
    mkdirSync(runtime);
    const bus = join(dir, 'bus');
    writeFileSync(bus, '');
    const env = { XDG_RUNTIME_DIR: runtime, DBUS_SESSION_BUS_ADDRESS: `unix:path=${bus},guid=1;unix:abstract=/tmp/x;tcp:host=h` };
    const services = userServicesBlocked(env, 7, 'linux');
    expect(services).toEqual({
      sockets: ['/run/dbus/system_bus_socket', '/var/run/dbus/system_bus_socket', bus],
      socketFolders: [runtime, '/run/user/7'],
    });
    expect(userServicesBlocked(env, 7, 'darwin')).toEqual({ sockets: [], socketFolders: [] });
    // the runtime folder is an empty tmpfs and the bus socket /dev/null; paths that do not exist are left out
    const { args } = sandboxed({ cmd: 'claude', args: [] }, { folders: [], files: [], ...services }, { platform: 'linux' });
    const mounts = args.join(' ');
    expect(mounts).toContain(`--tmpfs ${runtime} `);
    expect(mounts).toContain(`--ro-bind /dev/null ${bus} `);
    expect(mounts).not.toContain('/run/user/7');
    for (const name of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) expect(SANDBOX_DROPPED_ENV).toContain(name);
  });

  it('runs Claude Code without session files for play and judge', () => {
    const command = { cmd: 'claude', args: ['-p'] };
    expect(withoutSessionFiles('claude-code', command)).toEqual({ cmd: 'claude', args: ['-p', '--no-session-persistence'] });
    expect(withoutSessionFiles('codex', command)).toEqual(command);
  });
});

describe('files', () => {
  it('splits extensions', () => {
    expect(withoutExtension('/a/b.c/d.md')).toBe('/a/b.c/d');
    expect(withoutExtension('/a/b.c/d')).toBe('/a/b.c/d');
    expect(withoutExtension('/a/.hidden')).toBe('/a/.hidden');
    expect(extensionOf('/v/clip.mp4')).toBe('.mp4');
    expect(extensionOf('/v/clip')).toBe('');
  });

  it('names the run log after the result file with the same extension rule', () => {
    expect(runLogPath('/r/content-1.md')).toBe('/r/content-1-runs.json');
    expect(runLogPath('/r/.md')).toBe('/r/.md-runs.json');
    expect(runLogPath('/r.d/out')).toBe('/r.d/out-runs.json');
  });

  it('moves files into new folders', async () => {
    const dir = await newTempFolder('ogw-test-move-');
    writeFileSync(join(dir, 'a'), 'x');
    await move(join(dir, 'a'), join(dir, 'b', 'c'));
    expect(readFileSync(join(dir, 'b', 'c'), 'utf8')).toBe('x');
  });
});

describe('merge order', () => {
  it('orders modules by dependency step, then byte order', () => {
    const deps = new Map([
      ['b', ['a']],
      ['a', []],
      ['C', []],
      ['d', ['b', 'C']],
      ['e', ['missing']],
    ]);
    expect(topologicalOrder(deps)).toEqual(['C', 'a', 'e', 'b', 'd']);
    expect(byteCompare('Z', 'a')).toBeLessThan(0);
    // modules on a cycle and modules depending on one are left out; the others keep their order
    expect(topologicalOrder(new Map([['x', ['y']], ['y', ['x']], ['z', ['x']], ['w', []], ['v', ['w']]]))).toEqual(['w', 'v']);
  });

  it('puts module jobs by their last module position, then the other ids in given order', () => {
    const order = ['a', 'b', 'c'];
    const ids = mergeOrder(
      [
        { id: 'other1', modules: [] },
        { id: 'j1', modules: ['a', 'c'] },
        { id: 'j2', modules: ['b'] },
        { id: 'other2', modules: [] },
        { id: 'j3', modules: ['b'] },
      ],
      order,
    );
    expect(ids).toEqual({ ids: ['j2', 'j3', 'j1', 'other1', 'other2'], unordered: [] });
    expect(mergeOrder([{ id: 'x', modules: ['a', 'z'] }, { id: 'y', modules: ['a'] }], order)).toEqual({ ids: ['y'], unordered: [{ id: 'x', module: 'z' }] });
  });

  it('puts tool jobs before module jobs, even with no core-spec/', () => {
    const ids = mergeOrder(
      [
        { id: 'm', modules: ['a'] },
        { id: 'd', modules: ['data-tool'] },
        { id: 'c', modules: ['contract-tool'] },
      ],
      ['a'],
    );
    expect(ids.ids).toEqual(['d', 'c', 'm']);
    expect(mergeOrder([{ id: 'c', modules: ['contract-tool'] }], []).ids).toEqual(['c']);
  });
});

describe('core input command', () => {
  it('reads the command line', () => {
    expect(coreCommand('command: review fix\n- target: routing\n')).toBe('review-fix');
    expect(coreCommand('command: create server core\r\nmodule: auth\n')).toBe('create-server-core');
    expect(coreCommand('command: create contract tool')).toBe('create-contract-tool');
    expect(coreCommand('command: create client core  \n')).toBe('create-client-core');
    expect(coreCommand('command: update core\n')).toBe('update-core');
    const error = 'the first line of a core agent input is not `command: <command>` with one of create contract tool, create server core, create client core, update core, review fix: ';
    expect(() => coreCommand('nothing')).toThrow(`${error}nothing`);
    expect(() => coreCommand('# x\ncommand: update core\n')).toThrow(`${error}# x`);
    expect(() => coreCommand('- command: update core\n')).toThrow(`${error}- command: update core`);
    expect(() => coreCommand('command: build\n')).toThrow(`${error}command: build`);
    expect(() => coreCommand('command:update core\n')).toThrow(error);
    expect(() => coreCommand('')).toThrow(error);
  });
});

describe('play and judge input', () => {
  it('copies the path fields and rewrites only them', async () => {
    const dir = await newTempFolder('ogw-test-input-');
    writeFileSync(join(dir, 'guide-a.md'), 'A');
    writeFileSync(join(dir, 'guide-b.md'), 'B');
    writeFileSync(join(dir, 'clip.webm'), 'V');
    writeFileSync(join(dir, 'loss.mp4'), 'L');
    writeFileSync(join(dir, 'telemetry-1-1.md'), 'T');
    const input = {
      A: { instance: 'i1', playGuide: join(dir, 'guide-a.md') },
      B: { instance: 'i2', playGuide: join(dir, 'guide-b.md') },
      fixtures: [{ moment: { name: 'm', description: 'd' }, A: 'i3', B: null }],
      elements: ['game feel'],
      telemetry: join(dir, 'telemetry-1-1.md'),
      reference: {
        name: 'R',
        moments: [
          { name: 'a', video: join(dir, 'clip.webm'), startMs: 0, endMs: 1 },
          { name: 'b', video: null, startMs: null, endMs: null },
          { name: 'c', video: join(dir, 'loss.mp4'), startMs: 2, endMs: 3 },
          { name: 'd', video: join(dir, 'clip.webm'), startMs: 4, endMs: 5 },
        ],
      },
    };
    writeFileSync(join(dir, 'in.json'), JSON.stringify(input));
    const folder = join(dir, 'agent');
    mkdirSync(folder);
    const prepared = await preparePlayInput('judge', join(dir, 'in.json'), folder);
    expect(prepared.input).toBe(join(folder, 'input', 'input.json'));
    expect(prepared.instances).toEqual(['i1', 'i2', 'i3']);
    const written = JSON.parse(readFileSync(prepared.input, 'utf8')) as typeof input;
    expect(written).toEqual({
      ...input,
      A: { instance: 'i1', playGuide: join(folder, 'input', 'play-guide-A.md') },
      B: { instance: 'i2', playGuide: join(folder, 'input', 'play-guide-B.md') },
      telemetry: join(folder, 'input', 'telemetry.md'),
      reference: {
        name: 'R',
        moments: [
          { name: 'a', video: join(folder, 'input', 'reference-video-1.webm'), startMs: 0, endMs: 1 },
          { name: 'b', video: null, startMs: null, endMs: null },
          { name: 'c', video: join(folder, 'input', 'reference-video-2.mp4'), startMs: 2, endMs: 3 },
          { name: 'd', video: join(folder, 'input', 'reference-video-1.webm'), startMs: 4, endMs: 5 },
        ],
      },
    });
    expect(readFileSync(join(folder, 'input', 'reference-video-1.webm'), 'utf8')).toBe('V');
    expect(readFileSync(join(folder, 'input', 'reference-video-2.mp4'), 'utf8')).toBe('L');
    expect(readFileSync(join(folder, 'input', 'telemetry.md'), 'utf8')).toBe('T');
  });

  it('skips missing fields and fails on non-JSON input or a missing file', async () => {
    const dir = await newTempFolder('ogw-test-input-');
    writeFileSync(join(dir, 'g.md'), 'G');
    writeFileSync(join(dir, 'judge.json'), JSON.stringify({ A: { instance: 'i1', playGuide: join(dir, 'g.md') }, B: null, fixtures: [], telemetry: null, reference: null }));
    const ok = await preparePlayInput('judge', join(dir, 'judge.json'), join(dir, 'f1'));
    expect(JSON.parse(readFileSync(ok.input, 'utf8'))).toMatchObject({ B: null, telemetry: null, reference: null });
    writeFileSync(join(dir, 'bad.json'), 'not json');
    await expect(preparePlayInput('play', join(dir, 'bad.json'), join(dir, 'f2'))).rejects.toThrow('play input is not JSON');
    writeFileSync(join(dir, 'arr.json'), '[]');
    await expect(preparePlayInput('play', join(dir, 'arr.json'), join(dir, 'f3'))).rejects.toThrow('not a JSON object');
    writeFileSync(join(dir, 'gone.json'), JSON.stringify({ instance: 'i', playGuide: join(dir, 'nope.md'), moment: null }));
    await expect(preparePlayInput('play', join(dir, 'gone.json'), join(dir, 'f4'))).rejects.toThrow('playGuide: file not found');
    writeFileSync(join(dir, 'num.json'), JSON.stringify({ instance: 'i', playGuide: 3 }));
    await expect(preparePlayInput('play', join(dir, 'num.json'), join(dir, 'f5'))).rejects.toThrow('playGuide is not a path');
    await expect(preparePlayInput('play', join(dir, 'absent.json'), join(dir, 'f6'))).rejects.toThrow('file not found');
    const judge = (video: unknown): string => JSON.stringify({ A: null, B: null, fixtures: [], reference: { name: 'R', moments: [{ name: 'm', video, startMs: 0, endMs: 1 }] } });
    writeFileSync(join(dir, 'no-video.json'), judge(join(dir, 'nope.mp4')));
    await expect(preparePlayInput('judge', join(dir, 'no-video.json'), join(dir, 'f7'))).rejects.toThrow('judge input reference.moments video: file not found');
    writeFileSync(join(dir, 'num-video.json'), judge(3));
    await expect(preparePlayInput('judge', join(dir, 'num-video.json'), join(dir, 'f8'))).rejects.toThrow('judge input reference.moments video is not a path');
  });
});

describe('commitInCheckout', () => {
  it('commits the paths with commitPaths under the agent commit lock, with or without the pre-commit hook', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g1', { 'a.txt': 'a' });
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n');
    chmodSync(join(dir, '.git', 'hooks', 'pre-commit'), 0o755);
    const record = join(dir, 'records', 'r-runs.json');
    mkdirSync(join(dir, 'records'));
    writeFileSync(record, '{}');
    writeFileSync(join(dir, 'other.txt'), 'not committed');
    const before = sh(dir, 'git', ['rev-parse', 'HEAD']).trim();
    await expect(commitInCheckout(dir, [record], 'with hook', { env: ws.env, noVerify: false })).rejects.toThrow();
    let release = (): void => undefined;
    const held = withLock(join(dir, '.git', 'ogw-agent-commit.lock'), () => new Promise<void>((resolve) => (release = resolve)));
    const committing = commitInCheckout(dir, [record], 'records', { env: ws.env, noVerify: true });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(sh(dir, 'git', ['rev-parse', 'HEAD']).trim()).toBe(before);
    release();
    await held;
    await committing;
    expect(sh(dir, 'git', ['log', '-1', '--format=%s']).trim()).toBe('records');
    expect(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('records/r-runs.json');
    expect(sh(dir, 'git', ['status', '--porcelain']).trim()).toBe('?? other.txt');
  });

  it('commits a symlink as itself, never the path it points to', async () => {
    const ws = makeWorkspace();
    const dir = makeGame(ws, 'g1', { 'server/a.ts': 'a', 'records/.keep': '' });
    writeFileSync(join(dir, 'server', 'a.ts'), 'uncommitted change');
    const link = join(dir, 'records', 'r-runs.json');
    symlinkSync(join(dir, 'server'), link);
    await commitInCheckout(dir, [link], 'run log', { env: ws.env, noVerify: true });
    expect(sh(dir, 'git', ['show', '--name-only', '--format=', 'HEAD']).trim()).toBe('records/r-runs.json');
    expect(sh(dir, 'git', ['status', '--porcelain']).trim()).toBe('M server/a.ts');
  });
});
