import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { escapeRegExp } from '../../../lib/regexp.ts';
import type { AgentSettings, HarnessSettings, Role } from '../../../lib/settings.ts';

export interface CliCommand {
  cmd: string;
  args: string[];
}

export function agentSettings(settings: HarnessSettings, role: Role): AgentSettings {
  const agent = settings.agents[role];
  if (!agent) throw new OgwError(`harness settings agents.${role} is missing`);
  return agent;
}

export function agentCli(agent: AgentSettings): AgentCli {
  return agent.cli ?? 'claude-code';
}

/**
 * The agent CLI in the mode that asks no approval, with the role's model and effort.
 * The prompt goes to its stdin.
 */
export function agentCliCommand(agent: AgentSettings): CliCommand {
  const cli = agentCli(agent);
  if (cli === 'claude-code') {
    return {
      cmd: 'claude',
      args: ['-p', '--model', agent.model, '--effort', agent.effort, '--permission-mode', 'bypassPermissions'],
    };
  }
  return {
    cmd: 'codex',
    args: [
      'exec',
      '--model',
      agent.model,
      '-c',
      `model_reasoning_effort="${agent.effort}"`,
      '--dangerously-bypass-approvals-and-sandbox',
      '--skip-git-repo-check',
      '-',
    ],
  };
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The path with its deepest existing ancestor resolved, so that a sandbox rule for a path that does not exist yet
 * still matches it at its real path when it is made later (macOS matches the resolved path).
 */
export function resolvedPath(path: string): string {
  if (existsSync(path)) return real(path);
  const parent = dirname(path);
  return parent === path ? path : join(resolvedPath(parent), basename(path));
}

function sbString(path: string): string {
  return `"${path.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** What the sandbox blocks: everything under each folder, and each file, except the files in `except`. */
export interface Blocked {
  folders: readonly string[];
  files: readonly string[];
  /** Files under a blocked folder that the sandboxed process uses, for example its own output file. */
  except?: readonly string[];
  /** Folders under a blocked folder that stay readable and writable, for example the agent's broker folder. */
  exceptFolders?: readonly string[];
  /** Folders whose contents cannot be written; reading stays allowed. */
  readOnly?: readonly string[];
  /** Folders under a `readOnly` folder that stay writable. */
  writable?: readonly string[];
  /**
   * Linux: folders the sandbox shows as an empty folder, with the `keep` files in them bound back read-only.
   * macOS blocks their session stores through `folders` and `files` instead.
   */
  hidden?: readonly { folder: string; keep: readonly string[] }[];
  /** Unix socket files: reading, writing and connecting. Linux blocks only the ones that exist. */
  sockets?: readonly string[];
  /** Folders of unix sockets: everything under them, and connecting to a socket in them. Linux blocks only the ones that exist. */
  socketFolders?: readonly string[];
  /**
   * macOS: connecting to this host's own addresses (`localhost`) and to every unix socket except `allowSockets`.
   * Linux keeps the network: a network namespace would also cut the agent CLI off the internet.
   */
  localNetwork?: { allowSockets: readonly string[] };
  /**
   * The only places the sandbox writes, with `/dev`: every other write is blocked. The other fields still block what
   * they list inside these. Linux binds only the ones that exist; the files are bound after the hidden folders.
   */
  allowedWrites?: { folders: readonly string[]; files: readonly string[] };
  /**
   * The folders of other play and judge agents: reading and writing every entry directly under a `temps` folder whose
   * name starts with one of `prefixes`, except the agent's `own` folder. macOS: a regex rule, then `own` allowed.
   * Linux: each existing `temps` folder is an empty tmpfs with `own` bound back, so no entry made there, before or
   * after the sandbox starts, is seen from inside, and what the sandbox writes there stays inside it.
   * `claudeTemp` (macOS): Claude Code's temp root `/tmp/claude-<uid>`; reading and writing below it is blocked except
   * in the folder Claude Code uses for `own` (`claudeTempName`). Linux already hides `/tmp`.
   */
  agentFolders?: { temps: readonly string[]; prefixes: readonly string[]; own: string | null; claudeTemp?: string };
}

function bothForms(paths: readonly string[]): string[] {
  return [...new Set(paths.flatMap((path) => [path, resolvedPath(path)]))];
}

/**
 * macOS: what starts a process outside the sandbox. `launchctl` (launchd jobs), `open` (LaunchServices) and
 * `osascript` (AppleEvents) cannot run, and a copy of any of them still finds the LaunchServices and AppleEvents
 * mach services blocked. A signal goes only to processes of the sandbox: a launch the mach rules stop can leave the
 * app process stopped outside the sandbox, and `SIGCONT` would run it there.
 */
const MACOS_NO_OUTSIDE_LAUNCH = [
  '(deny process-exec (literal "/bin/launchctl") (literal "/usr/bin/open") (literal "/usr/bin/osascript"))',
  '(deny mach-lookup (global-name-prefix "com.apple.coreservices.") (global-name "com.apple.coreservicesd"))',
  '(deny appleevent-send)',
  '(deny signal)',
  '(allow signal (target same-sandbox))',
];

/** macOS: the unix socket of the DNS resolver (`mDNSResponder`) that every host name lookup goes through. */
export const MACOS_DNS_SOCKET = '/var/run/mDNSResponder';

function subpaths(paths: readonly string[]): string {
  return bothForms(paths).map((path) => `(subpath ${sbString(path)})`).join(' ');
}

/** macOS: the rules that block every write but those in `allowedWrites` and `/dev`. */
function allowedWriteRules(allowed: Blocked['allowedWrites']): string[] {
  if (allowed === undefined) return [];
  const rules = [
    '(subpath "/dev")',
    ...bothForms(allowed.folders).map((path) => `(subpath ${sbString(path)})`),
    ...bothForms(allowed.files).map((path) => `(literal ${sbString(path)})`),
  ].join(' ');
  return ['(deny file-write*)', `(allow file-write* ${rules})`];
}

/** The name of the folder Claude Code uses under its temp root for a session started in `folder`. */
export function claudeTempName(folder: string): string {
  return folder.replace(/[^A-Za-z0-9-]/g, '-');
}

/**
 * macOS: the rules that block below Claude Code's temp root (`agentFolders.claudeTemp`) and keep open the folder of the
 * agent's own folder, named after the path as given and its real path.
 */
function claudeTempRules(agentFolders: NonNullable<Blocked['agentFolders']>): string[] {
  if (agentFolders.claudeTemp === undefined) return [];
  const roots = bothForms([resolve(agentFolders.claudeTemp)]);
  const own = agentFolders.own;
  const names = own === null ? [] : [...new Set([resolve(own), resolvedPath(own)].map(claudeTempName))];
  const allowed = roots.flatMap((root) => names.map((name) => `(subpath ${sbString(join(root, name))})`)).join(' ');
  return [
    `(deny file-read* file-write* ${roots.map((root) => `(regex ${sbString(`^${escapeRegExp(root)}/`)})`).join(' ')})`,
    ...(allowed === '' ? [] : [`(allow file-read* file-write* ${allowed})`]),
  ];
}

/** macOS: the rules that block the folders of other agents (`agentFolders`) and keep the agent's own folder open. */
function otherAgentFolderRules(agentFolders: NonNullable<Blocked['agentFolders']>): string[] {
  if (agentFolders.prefixes.length === 0) return [];
  const prefixes = agentFolders.prefixes.map(escapeRegExp).join('|');
  const regexes = bothForms(agentFolders.temps.map((temp) => resolve(temp)))
    .map((temp) => `(regex ${sbString(`^${escapeRegExp(temp === '/' ? '' : temp)}/(${prefixes})`)})`)
    .join(' ');
  return [
    ...(regexes === '' ? [] : [`(deny file-read* file-write* ${regexes})`]),
    ...(agentFolders.own === null ? [] : [`(allow file-read* file-write* ${subpaths([agentFolders.own])})`]),
  ];
}

function agentFolderRules(agentFolders: Blocked['agentFolders']): string[] {
  return agentFolders === undefined ? [] : [...otherAgentFolderRules(agentFolders), ...claudeTempRules(agentFolders)];
}

/**
 * macOS `sandbox-exec` profile that blocks every write but `allowedWrites`, writing under the read-only folders,
 * reading and writing under the folders and of the files, the unix sockets, the local network, and starting a process
 * outside the sandbox. A later rule wins over an earlier one.
 */
export function macosProfile(blocked: Blocked): string {
  const sockets = blocked.sockets ?? [];
  const socketFolders = blocked.socketFolders ?? [];
  const readOnly = subpaths(blocked.readOnly ?? []);
  const writable = subpaths(blocked.writable ?? []);
  const rules = [
    ...bothForms([...blocked.folders, ...socketFolders]).map((path) => `(subpath ${sbString(path)})`),
    ...bothForms([...blocked.files, ...sockets]).map((path) => `(literal ${sbString(path)})`),
  ].join(' ');
  const except = [
    ...bothForms(blocked.except ?? []).map((path) => `(literal ${sbString(path)})`),
    ...bothForms(blocked.exceptFolders ?? []).map((path) => `(subpath ${sbString(path)})`),
  ].join(' ');
  const network = blocked.localNetwork;
  const allowSockets = bothForms(network?.allowSockets ?? [])
    .map((path) => `(remote unix-socket (path-literal ${sbString(path)}))`)
    .join(' ');
  // one `remote unix-socket` filter per path: the filters inside one `remote` must all match
  const connect = [
    ...bothForms(sockets).map((path) => `(remote unix-socket (path-literal ${sbString(path)}))`),
    ...bothForms(socketFolders).map((path) => `(remote unix-socket (subpath ${sbString(path)}))`),
  ].join(' ');
  return [
    '(version 1)',
    '(allow default)',
    ...allowedWriteRules(blocked.allowedWrites),
    ...(readOnly === '' ? [] : [`(deny file-write* ${readOnly})`]),
    ...(writable === '' ? [] : [`(allow file-write* ${writable})`]),
    ...agentFolderRules(blocked.agentFolders),
    `(deny file-read* file-write* ${rules})`,
    ...(except === '' ? [] : [`(allow file-read* file-write* ${except})`]),
    // `localhost` matches every address of this host, not only the loopback ones
    ...(network === undefined ? [] : ['(deny network-outbound (remote ip "localhost:*") (remote unix-socket (subpath "/")))']),
    ...(allowSockets === '' ? [] : [`(allow network-outbound ${allowSockets})`]),
    ...(connect === '' ? [] : [`(deny network-outbound ${connect})`]),
    ...MACOS_NO_OUTSIDE_LAUNCH,
    '',
  ].join('\n');
}

/**
 * Linux: makes each blocked folder and file that does not exist yet (an empty folder, an empty file), so that each
 * gets its mount at its real path and what a process outside the sandbox writes there later stays blocked. Each
 * read-only, writable, excepted and hidden folder is made when missing; nothing is made in a hidden one. Sockets and
 * their folders are not made. macOS makes nothing: its rules match paths that do not exist.
 */
export function makeBlocked(blocked: Blocked, platform: NodeJS.Platform = process.platform): void {
  if (platform !== 'linux') return;
  const folders = [...blocked.folders, ...(blocked.readOnly ?? []), ...(blocked.writable ?? []), ...(blocked.exceptFolders ?? [])];
  for (const folder of folders) mkdirSync(folder, { recursive: true });
  for (const file of blocked.files) {
    mkdirSync(dirname(file), { recursive: true });
    closeSync(openSync(file, 'a'));
  }
  for (const { folder } of blocked.hidden ?? []) mkdirSync(folder, { recursive: true });
}

/** bubblewrap mounts of the hidden folders: an empty tmpfs, then each existing `keep` file bound back read-only. */
function hiddenMounts(hidden: Blocked['hidden']): string[] {
  return (hidden ?? []).flatMap(({ folder, keep }) => {
    const target = real(folder);
    const files = keep.filter((file) => existsSync(file));
    return ['--tmpfs', target, ...files.flatMap((file) => ['--ro-bind', real(file), join(target, relative(folder, file))])];
  });
}

function binds(option: '--bind' | '--ro-bind', paths: readonly string[] | undefined): string[] {
  return (paths ?? []).flatMap((path) => [option, real(path), real(path)]);
}

function existing(paths: readonly string[] | undefined): string[] {
  return [...new Set((paths ?? []).filter((path) => existsSync(path)).map(real))];
}

/**
 * bubblewrap mounts of `agentFolders`: each existing temp folder an empty tmpfs (a parent before a folder in it), then
 * the agent's own folder bound back. `covered` are the folders these mounts already handle.
 */
function privateTempMounts(agentFolders: Blocked['agentFolders']): { mounts: string[]; covered: string[] } {
  const temps = existing(agentFolders?.temps).sort((a, b) => a.length - b.length);
  const own = existing(agentFolders?.own === null || agentFolders?.own === undefined ? [] : [agentFolders.own]);
  return { mounts: [...temps.flatMap((path) => ['--tmpfs', path]), ...binds('--bind', own)], covered: [...temps, ...own] };
}

/**
 * Wraps a command in the OS sandbox that blocks what `blocked` lists, for the process and all its child processes:
 * macOS `sandbox-exec` (`macosProfile`, which also blocks starting a process outside the sandbox), Linux bubblewrap
 * (with `allowedWrites`: `/` bound read-only, `/dev` bound as it is, each `agentFolders` temp folder an empty tmpfs
 * with the agent's own folder bound back, and the other allowed folders bound writable; the
 * read-only folders bound read-only, the writable ones bound back writable, an empty tmpfs over each folder,
 * `/dev/null` over each file and socket, the excepted folders bound back, and a new PID namespace with its own
 * `/proc` unless `pidNamespace` is false). On Linux every blocked path must exist (`makeBlocked`). `except` files are
 * for file descriptors the caller opens before the sandbox starts: macOS allows them (it checks even `fstat` on such
 * a descriptor), and on Linux a descriptor keeps its file under the tmpfs.
 */
export function sandboxed(
  command: CliCommand,
  blocked: Blocked,
  options: { platform?: NodeJS.Platform; macosProfileFile?: string; pidNamespace?: boolean } = {},
): CliCommand {
  const platform = options.platform ?? process.platform;
  if (platform === 'darwin') {
    // a long profile goes in a file the caller wrote with `macosProfile(blocked)`
    const profile = options.macosProfileFile === undefined ? ['-p', macosProfile(blocked)] : ['-f', options.macosProfileFile];
    return { cmd: 'sandbox-exec', args: [...profile, command.cmd, ...command.args] };
  }
  if (platform === 'linux') {
    const allowed = blocked.allowedWrites;
    const root =
      allowed === undefined
        ? ['--dev-bind', '/', '/']
        : ['--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev'];
    const privateTemps = privateTempMounts(blocked.agentFolders);
    const mounts = [
      ...privateTemps.mounts,
      ...binds('--bind', existing(allowed?.folders).filter((path) => !privateTemps.covered.includes(path))),
      ...binds('--ro-bind', blocked.readOnly),
      ...binds('--bind', blocked.writable),
      ...blocked.folders.flatMap((path) => ['--tmpfs', real(path)]),
      ...blocked.files.flatMap((path) => ['--ro-bind', '/dev/null', real(path)]),
      ...hiddenMounts(blocked.hidden),
      ...binds('--bind', existing(allowed?.files)),
      ...(blocked.socketFolders ?? []).filter((path) => existsSync(path)).flatMap((path) => ['--tmpfs', real(path)]),
      ...(blocked.sockets ?? []).filter((path) => existsSync(path)).flatMap((path) => ['--ro-bind', '/dev/null', real(path)]),
      ...binds('--bind', blocked.exceptFolders),
    ];
    const pid = options.pidNamespace === false ? [] : ['--unshare-pid', '--proc', '/proc'];
    return {
      cmd: 'bwrap',
      args: [...root, ...pid, ...mounts, '--die-with-parent', '--', command.cmd, ...command.args],
    };
  }
  throw new OgwError(`the sandbox runs only on macOS and Linux, not on ${platform}`);
}


/** The env variable that sets the config folder of each agent CLI, and its folder in home when the variable is not set. */
const CONFIG: Record<AgentCli, { variable: string; home: string }> = {
  'claude-code': { variable: 'CLAUDE_CONFIG_DIR', home: '.claude' },
  codex: { variable: 'CODEX_HOME', home: '.codex' },
};

/**
 * What in the config folder of each agent CLI holds the sessions of other agents (transcripts, prompt history, logs,
 * memories, file snapshots, plans, todo lists): folders, files, and file name patterns of the folder's top level.
 * `companions` are the suffixes of the files that go with a matched file (the SQLite `-wal`, `-shm` files), blocked
 * even when they do not exist yet. The login (Claude Code: the macOS Keychain or `.credentials.json`; Codex: `auth.json`)
 * and the settings are not in it. `linuxKeep` set: on Linux the whole folder is hidden and only these files are kept.
 */
const SESSION_STORES: Record<
  AgentCli,
  { folders: readonly string[]; files: readonly string[]; patterns: readonly RegExp[]; companions: readonly string[]; linuxKeep?: readonly string[] }
> = {
  'claude-code': {
    folders: ['projects', 'file-history', 'todos', 'plans', 'debug'],
    files: ['history.jsonl'],
    patterns: [],
    companions: [],
  },
  codex: {
    folders: ['sessions', 'archived_sessions', 'log'],
    files: ['history.jsonl'],
    patterns: [/^(state|logs|memories)_[0-9]+\.sqlite(-wal|-shm)?$/],
    companions: ['-wal', '-shm'],
    linuxKeep: ['auth.json', 'config.toml'],
  },
};

export type AgentCli = NonNullable<AgentSettings['cli']>;

/** The config folder an agent CLI uses: its env variable, else the folder in home. */
export function defaultConfigFolder(cli: AgentCli, env: NodeJS.ProcessEnv): string {
  const config = CONFIG[cli];
  const set = env[config.variable];
  return set !== undefined && set !== '' ? set : join(env.HOME ?? homedir(), config.home);
}

function topLevelNames(folder: string): string[] {
  try {
    return readdirSync(folder);
  } catch {
    return [];
  }
}

/**
 * What the play and judge sandbox blocks in the config folders of both agent CLIs: the session stores of the other
 * agents (`SESSION_STORES`). The agent CLI keeps its own config folder, so it keeps the user's login. On Linux a
 * config folder with `linuxKeep` is hidden whole, with only those files kept read-only.
 */
export function agentHomeBlocked(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Blocked {
  const folders: string[] = [];
  const files: string[] = [];
  const hidden: { folder: string; keep: string[] }[] = [];
  for (const cli of Object.keys(CONFIG) as AgentCli[]) {
    const home = defaultConfigFolder(cli, env);
    const stores = SESSION_STORES[cli];
    if (platform === 'linux' && stores.linuxKeep !== undefined) {
      hidden.push({ folder: home, keep: stores.linuxKeep.map((name) => join(home, name)) });
      continue;
    }
    folders.push(...stores.folders.map((name) => join(home, name)));
    const matched = topLevelNames(home).filter((name) => stores.patterns.some((pattern) => pattern.test(name)));
    const withCompanions = matched.flatMap((name) =>
      stores.companions.some((suffix) => name.endsWith(suffix)) ? [name] : [name, ...stores.companions.map((suffix) => name + suffix)],
    );
    files.push(...new Set([...stores.files, ...withCompanions].map((name) => join(home, name))));
  }
  return hidden.length === 0 ? { folders, files } : { folders, files, hidden };
}

/** The login file of each agent CLI in its config folder, which the CLI writes when it renews the login. */
const LOGIN_FILES: Record<AgentCli, string> = { 'claude-code': '.credentials.json', codex: 'auth.json' };

/**
 * The login of both agent CLIs, the only place in home the play and judge sandbox writes: the login files, and on
 * macOS the Keychain folder (Claude Code keeps its login in the Keychain there).
 */
export function agentLoginWrites(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): { folders: string[]; files: string[] } {
  const files = (Object.keys(CONFIG) as AgentCli[]).map((cli) => join(defaultConfigFolder(cli, env), LOGIN_FILES[cli]));
  const folders = platform === 'darwin' ? [join(env.HOME ?? homedir(), 'Library', 'Keychains')] : [];
  return { folders, files };
}

const UNIX_SCHEME = 'unix://';

/** The unix socket path of a Docker host value, or null. */
function unixPath(host: unknown): string | null {
  return typeof host === 'string' && host.startsWith(UNIX_SCHEME) && host.length > UNIX_SCHEME.length ? host.slice(UNIX_SCHEME.length) : null;
}

/** The unix socket endpoints of the Docker contexts in `<docker config>/contexts/meta/<id>/meta.json`. */
function contextSockets(dockerConfig: string): string[] {
  const meta = join(dockerConfig, 'contexts', 'meta');
  return topLevelNames(meta).flatMap((id) => {
    try {
      const parsed = JSON.parse(readFileSync(join(meta, id, 'meta.json'), 'utf8')) as { Endpoints?: { docker?: { Host?: unknown } } };
      const path = unixPath(parsed.Endpoints?.docker?.Host);
      return path === null ? [] : [path];
    } catch {
      return [];
    }
  });
}

/**
 * The Docker daemon sockets the play and judge sandbox blocks: the default socket paths, the unix socket of
 * `DOCKER_HOST` and of the Docker contexts, and the Docker Desktop, Colima and OrbStack folders in home.
 */
export function dockerBlocked(env: NodeJS.ProcessEnv): Pick<Blocked, 'sockets' | 'socketFolders'> {
  const home = env.HOME ?? homedir();
  const dockerConfig = env.DOCKER_CONFIG !== undefined && env.DOCKER_CONFIG !== '' ? env.DOCKER_CONFIG : join(home, '.docker');
  const sockets = [
    '/var/run/docker.sock',
    '/run/docker.sock',
    ...(env.XDG_RUNTIME_DIR ? [join(env.XDG_RUNTIME_DIR, 'docker.sock')] : []),
    ...[unixPath(env.DOCKER_HOST)].filter((path): path is string => path !== null),
    ...contextSockets(dockerConfig),
  ];
  return {
    sockets: [...new Set(sockets)],
    socketFolders: [...new Set([join(dockerConfig, 'run'), join(home, '.docker', 'run'), join(home, '.colima'), join(home, '.orbstack')])],
  };
}

/**
 * The unix sockets of other local services the play and judge sandbox blocks: the SSH agent (`SSH_AUTH_SOCK`) and
 * tmux (the socket `TMUX` names, its folder, and the socket folder `tmux-<uid>` in `TMUX_TMPDIR` and in `/tmp`).
 */
export function localSocketsBlocked(env: NodeJS.ProcessEnv, uid: number | null = process.getuid?.() ?? null): Pick<Blocked, 'sockets' | 'socketFolders'> {
  const sockets: string[] = [];
  const socketFolders: string[] = [];
  if (env.SSH_AUTH_SOCK) sockets.push(env.SSH_AUTH_SOCK);
  const tmux = env.TMUX?.split(',')[0];
  if (tmux) {
    sockets.push(tmux);
    socketFolders.push(dirname(tmux));
  }
  if (uid !== null) {
    for (const base of [env.TMUX_TMPDIR, '/tmp']) if (base) socketFolders.push(join(base, `tmux-${String(uid)}`));
  }
  return { sockets: [...new Set(sockets)], socketFolders: [...new Set(socketFolders)] };
}

/** The unix socket paths (`unix:path=`) of a D-Bus address list. */
function busPaths(address: string | undefined): string[] {
  return (address ?? '').split(';').flatMap((entry) => {
    if (!entry.startsWith('unix:')) return [];
    const path = entry
      .slice('unix:'.length)
      .split(',')
      .find((pair) => pair.startsWith('path='));
    return path === undefined || path === 'path=' ? [] : [path.slice('path='.length)];
  });
}

/**
 * Linux: the ways to the user's services outside the sandbox, which can start a process outside it (systemd
 * `StartTransientUnit`). The runtime folders (`XDG_RUNTIME_DIR` and `/run/user/<uid>`: the D-Bus session bus, systemd,
 * the keyring, Podman), the session bus socket `DBUS_SESSION_BUS_ADDRESS` names (`unix:path=`; an `unix:abstract=`
 * socket has no path to block), and the D-Bus system bus socket. Other OS: none.
 */
export function userServicesBlocked(
  env: NodeJS.ProcessEnv,
  uid: number | null = process.getuid?.() ?? null,
  platform: NodeJS.Platform = process.platform,
): Pick<Blocked, 'sockets' | 'socketFolders'> {
  if (platform !== 'linux') return { sockets: [], socketFolders: [] };
  const socketFolders = [...(env.XDG_RUNTIME_DIR ? [env.XDG_RUNTIME_DIR] : []), ...(uid === null ? [] : [`/run/user/${String(uid)}`])];
  const sockets = ['/run/dbus/system_bus_socket', '/var/run/dbus/system_bus_socket', ...busPaths(env.DBUS_SESSION_BUS_ADDRESS)];
  return { sockets: [...new Set(sockets)], socketFolders: [...new Set(socketFolders)] };
}

/**
 * Environment variables the play and judge agent CLI does not get: they point a Docker client at a daemon, an SSH
 * client at the SSH agent, tmux at its server, and a D-Bus client at the user's services.
 */
export const SANDBOX_DROPPED_ENV: readonly string[] = [
  'DOCKER_HOST',
  'DOCKER_CONTEXT',
  'SSH_AUTH_SOCK',
  'TMUX',
  'TMUX_PANE',
  'DBUS_SESSION_BUS_ADDRESS',
  'XDG_RUNTIME_DIR',
];

/** play, judge: the agent CLI command that keeps no session file of its own (Claude Code `--no-session-persistence`). */
export function withoutSessionFiles(cli: AgentCli, command: CliCommand): CliCommand {
  return cli === 'claude-code' ? { cmd: command.cmd, args: [...command.args, '--no-session-persistence'] } : command;
}
