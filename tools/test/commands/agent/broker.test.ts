// The play and judge broker: `ogw` inside the sandbox sends each command to a broker outside it.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { BROKER_COMMANDS, brokerCommand, startBroker } from '../../../src/commands/agent/lib/broker.ts';
import { commands } from '../../../src/commands/index.ts';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { BROKER_RUN, forwardToBroker, type BrokerIo } from '../../../src/lib/broker-client.ts';
import { findCommand } from '../../../src/lib/cli.ts';
import { jobsDir } from '../../../src/lib/jobs.ts';
import { newAgentKey } from '../../../src/lib/agentctx.ts';
import { fakeAgentJob } from '../instance/agents.ts';
import { cliEntry } from '../../../src/lib/paths.ts';
import { isAlive } from '../../../src/lib/proc.ts';
import { ogw, makeWorkspace, realHarness, sh } from '../../helpers/workspace.ts';
import { jobWorkspace, writeJob } from '../job/helpers.ts';
import { fakeAgentCli, gameWithRun, runAgent } from './helpers.ts';

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
  stdinRead: number;
}

async function forward(socket: string, argv: string[], env: NodeJS.ProcessEnv, stdin = ''): Promise<Captured> {
  const out: Captured = { code: -1, stdout: '', stderr: '', stdinRead: 0 };
  const io: BrokerIo = {
    cwd: process.cwd(),
    env,
    stdin: () => {
      out.stdinRead++;
      return Promise.resolve(stdin);
    },
    stdout: (text) => {
      out.stdout += text;
    },
    stderr: (text) => {
      out.stderr += text;
    },
  };
  out.code = await forwardToBroker(socket, argv, io);
  return out;
}

/** A process that asks the broker for stdin through fd 3 and prints what it got. */
const READS_STDIN = [
  '-e',
  "require('node:fs').writeSync(3, 'stdin\\n'); let d = ''; process.stdin.on('data', (c) => (d += c)).on('end', () => process.stdout.write('got ' + d));",
];

/** The sections of a harness document that start with these headings, or the whole document. */
function sections(file: string, headings: readonly string[] | null): string {
  const text = readFileSync(join(realHarness, file), 'utf8');
  if (headings === null) return text;
  return text
    .split(/^(?=## )/m)
    .filter((part) => headings.some((heading) => part.startsWith(`${heading}\n`)))
    .join('');
}

describe('broker', () => {
  it('runs a broker command with the agent key as that agent, gives stdin only when the command reads it, and refuses another key', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'ag1', command: 'agent', supervisorPid: process.pid, meta: { role: 'play', runLog: join(ws.root, 'runs.json') } });
    const socket = join(await newTempFolder('ogw-broker-'), 'b', 's');
    const key = 'ag1.nonce';
    const broker = await startBroker({
      socket,
      key,
      command: (argv) =>
        argv[1] === 'reads-stdin' ? { cmd: process.execPath, args: READS_STDIN } : { cmd: process.execPath, args: [cliEntry(), BROKER_RUN, ...argv] },
      env: { ...ws.env, OGW_AGENT_KEY: key },
    });
    try {
      expect(statSync(join(socket, '..')).mode & 0o777).toBe(0o700);
      const env = { OGW_AGENT_KEY: key };
      const status = await forward(socket, ['job', 'status', 'ag1'], env);
      expect(status).toEqual({ ...(await ogw(ws, ['job', 'status', 'ag1'])), stdinRead: 0 });
      // the exit code of `job wait` on a running job comes through
      const wait = await forward(socket, ['job', 'wait', 'ag1', '--timeout', '0'], env);
      expect(wait).toMatchObject({ code: 75, stdout: 'running\n' });
      // `--help` of a broker command
      const help = await forward(socket, ['input', '--help'], env);
      expect(help).toEqual({ ...(await ogw(ws, ['input', '--help'])), stdinRead: 0 });
      expect(help.code).toBe(0);
      // stdin goes to a command that reads it
      const read = await forward(socket, ['input', 'reads-stdin'], env, 'typed\n');
      expect(read).toMatchObject({ code: 0, stdout: 'got typed\n', stdinRead: 1 });
      for (const forged of ['ag1.other', 'ag2.nonce', '']) {
        const refused = await forward(socket, ['job', 'status', 'ag1'], { OGW_AGENT_KEY: forged });
        expect(refused).toMatchObject({ code: 1, stdout: '' });
        expect(refused.stderr).toContain('is not the key of this agent');
      }
    } finally {
      await broker.close();
    }
    expect(existsSync(join(socket, '..'))).toBe(false);
    const gone = await forward(socket, ['job', 'status', 'ag1'], { OGW_AGENT_KEY: key });
    expect(gone.code).toBe(1);
    expect(gone.stderr).toContain('cannot reach the ogw broker');
  });

  it('refuses the step or input of a play agent past its play budget before it starts a command, and lets the release of a held input through', async () => {
    const ws = jobWorkspace();
    const folder = await newTempFolder('ogw-broker-');
    const input = join(folder, 'input.json');
    writeFileSync(input, JSON.stringify({ instance: 'instp1', playGuide: '/x' }));
    const key = newAgentKey('agplay1');
    const remove = await fakeAgentJob(ws.env, 'agplay1', { role: 'play', cliPid: 999_999, keyHash: key.hash, input, folder });
    const socket = join(folder, 'b', 's');
    const started: string[][] = [];
    const broker = await startBroker({
      socket,
      key: key.value,
      command: (argv) => {
        started.push([...argv]);
        return { cmd: process.execPath, args: ['-e', "process.stdout.write('ran\\n')"] };
      },
      env: { ...ws.env, OGW_AGENT_KEY: key.value },
    });
    try {
      const env = { OGW_AGENT_KEY: key.value };
      // the first step notes the start of the play
      expect(await forward(socket, ['step', 'instp1', '50'], env)).toMatchObject({ code: 0, stdout: 'ran\n' });
      const file = join(await jobsDir(ws.env), 'play-budget', 'agplay1');
      writeFileSync(file, String(Date.now() - 900_000));
      started.length = 0;
      for (const argv of [['step', 'instp1', '50', '--state'], ['input', 'instp1', 'key_down', 'a'], ['input', 'instp1', '--script', 's.txt']]) {
        const refused = await forward(socket, argv, env);
        expect(refused).toMatchObject({ code: 1, stdout: '' });
        expect(refused.stderr).toContain('the play budget of 900 s since the first input has passed');
      }
      expect(started).toEqual([]);
      expect(await forward(socket, ['input', 'instp1', 'key_up', 'a'], env)).toMatchObject({ code: 0, stdout: 'ran\n' });
      expect(await forward(socket, ['input', 'instp1', 'pad_axis', 'left_x', '0'], env)).toMatchObject({ code: 0, stdout: 'ran\n' });
      expect((await forward(socket, ['input', 'instp1', 'pad_axis', 'left_x', '1'], env)).code).toBe(1);
      expect(await forward(socket, ['capture', 'instp1'], env)).toMatchObject({ code: 0, stdout: 'ran\n' });
      expect(started).toEqual([['input', 'instp1', 'key_up', 'a'], ['input', 'instp1', 'pad_axis', 'left_x', '0'], ['capture', 'instp1']]);
    } finally {
      await broker.close();
      remove();
      await rm(folder, { recursive: true, force: true });
    }
  });

  it('ends a forwarded command still running when it closes', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'ag1', command: 'agent', supervisorPid: process.pid, meta: { role: 'play', runLog: join(ws.root, 'runs.json') } });
    // a job that stays running: `job wait` on it does not end by itself
    writeJob(ws.jobs, { id: 'long1', supervisorPid: process.pid });
    const dir = await newTempFolder('ogw-broker-');
    const socket = join(dir, 'b', 's');
    const pidFile = join(dir, 'pid');
    const key = 'ag1.nonce';
    const broker = await startBroker({
      socket,
      key,
      // the shell writes its pid, then becomes the forwarded `ogw job wait`
      command: (argv) => ({ cmd: '/bin/sh', args: ['-c', `echo $$ > "${pidFile}"; exec "$@"`, 'sh', process.execPath, cliEntry(), BROKER_RUN, ...argv] }),
      env: { ...ws.env, OGW_AGENT_KEY: key },
    });
    const call = forward(socket, ['job', 'wait', 'long1', '--timeout', '600000'], { OGW_AGENT_KEY: key });
    let pid = 0;
    for (let i = 0; i < 200 && pid === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      pid = existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8')) : 0;
    }
    expect(pid).toBeGreaterThan(0);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(isAlive(pid)).toBe(true);
    await broker.close();
    expect((await call).code).not.toBe(0);
    for (let i = 0; i < 100 && isAlive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 50));
    expect(isAlive(pid)).toBe(false);
  });

  it('refuses every command that is not a broker command without running it or reading its stdin', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'ag1', command: 'agent', supervisorPid: process.pid, meta: { role: 'play', runLog: join(ws.root, 'runs.json') } });
    const socket = join(await newTempFolder('ogw-broker-'), 'b', 's');
    const key = 'ag1.nonce';
    let started = 0;
    const broker = await startBroker({
      socket,
      key,
      command: (argv) => {
        started++;
        return { cmd: process.execPath, args: [cliEntry(), BROKER_RUN, ...argv] };
      },
      env: { ...ws.env, OGW_AGENT_KEY: key },
    });
    const refusedCalls: [string[], string][] = [
      [['secret', 'set', '--harness', 'huggingface'], 'ogw secret set'],
      [['secret', 'show', '--harness', 'huggingface'], 'ogw secret show'],
      [['settings', 'set', 'harness', 'humanLanguage', 'en'], 'ogw settings set'],
      [['settings', 'get', 'harness', 'humanLanguage'], 'ogw settings get'],
      [['loop', 'evaluate', 'g', '--background'], 'ogw loop evaluate'],
      [['check', 'g', '--static', '--background'], 'ogw check g'],
      [['command', 'inst1', 'get_state'], 'ogw command inst1'],
      [['instance', 'start', 'g'], 'ogw instance start'],
      [['instance', 'stop', 'inst1'], 'ogw instance stop'],
      [['job', 'cancel', 'ag1'], 'ogw job cancel'],
      [['job'], 'ogw job'],
      [['--help'], 'ogw'],
      [[], 'ogw'],
    ];
    try {
      for (const [argv, words] of refusedCalls) {
        const refused = await forward(socket, argv, { OGW_AGENT_KEY: key }, 'hf-value\n');
        expect(refused).toMatchObject({ code: 1, stdout: '', stdinRead: 0 });
        expect(refused.stderr).toBe(
          `ogw broker: ${words} is not a command of the play and judge agents; they run only ogw input, ogw capture, ogw log, ` +
            'ogw telemetry, ogw telemetry compare, ogw step-mode, ogw step, ogw frames, ogw instance release, ogw instance wait, ogw job status, ogw job wait\n',
        );
      }
    } finally {
      await broker.close();
    }
    expect(started).toBe(0);
    expect(existsSync(ws.env.OGW_TEST_SECRET_FILE as string) ? readFileSync(ws.env.OGW_TEST_SECRET_FILE as string, 'utf8') : '').not.toContain('hf-value');
  });

  it('matches each argv as the CLI does: no other command extends a broker command name', () => {
    for (const def of commands) {
      const match = brokerCommand(def.name);
      if (match !== null) expect(BROKER_COMMANDS).toContainEqual(def.name);
    }
    for (const name of BROKER_COMMANDS) {
      expect(findCommand(commands, name)?.name).toEqual(name);
      expect(brokerCommand([...name, 'x', '--json'])).toEqual(name);
    }
    expect(brokerCommand(['telemetry', 'compare', 'a', 'b'])).toEqual(['telemetry', 'compare']);
    expect(brokerCommand(['telemetry', 'a', '--summary'])).toEqual(['telemetry']);
    expect(brokerCommand(['step-mode', 'a', 'on'])).toEqual(['step-mode']);
  });

  it('holds every command the play and judge documents have those agents run, and no other but job status and job wait', () => {
    const text = [
      sections('agents/play.md', ['## how to play']),
      sections('agents/judge.md', ['## how to play', '## verdict']),
      sections('skills/game-loop/instance.md', ['## commands', '## play']),
    ].join('\n');
    const used = new Set<string>();
    for (const match of text.matchAll(/`ogw ([^`]*)`/g)) {
      const def = findCommand(commands, (match[1] as string).split(' '));
      // instance.md lists `ogw command`, which it says play and judge agents cannot use
      if (def !== null && def.name[0] !== 'command') used.add(def.name.join(' '));
    }
    const broker = new Set(BROKER_COMMANDS.map((name) => name.join(' ')));
    expect([...used].sort()).toEqual([...broker].filter((name) => !name.startsWith('job ')).sort());
    expect(text).toContain('`ogw command <instance> <name> [<argument>...]` |');
    expect(sections('skills/game-loop/instance.md', ['## commands'])).toContain('The play agent and the judge agent cannot use it');
  });
});

/** A unix socket server and a TCP server on every address that answer `hi`. */
async function servers(dir: string): Promise<{ unix: string; port: number; close: () => void }> {
  const unix = join(dir, 'other.sock');
  const answer = (): Server => createServer((connection) => connection.end('hi'));
  const onUnix = answer();
  const onTcp = answer();
  await new Promise<void>((resolve) => onUnix.listen(unix, resolve));
  await new Promise<void>((resolve) => onTcp.listen(0, '::', resolve));
  const address = onTcp.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    unix,
    port,
    close: () => {
      onUnix.close();
      onTcp.close();
    },
  };
}

describe.runIf(process.platform === 'darwin')('broker with the real macOS sandbox', () => {
  it('runs ogw commands of the sandboxed agent through the broker; the sandbox writes no harness repo or jobs folder and reaches no local service', async () => {
    const ws = makeWorkspace();
    const { root } = await gameWithRun(ws, { 'play-guide.md': '# guide\n' });
    const dir = await newTempFolder('ogw-broker-e2e-');
    const local = await servers(dir);
    const jobs = await jobsDir(ws.env);
    const probe = join(realHarness, 'tools', 'src', `zz-sandbox-probe-${String(process.pid)}.ts`);
    const writes = {
      settings: join(ws.harness, 'settings.json'),
      harnessTools: join(ws.harness, 'tools', 'x.ts'),
      harnessHook: join(ws.harness, '.git', 'hooks', 'pre-commit'),
      codeSrc: probe,
      jobRecord: join(jobs, 'forged.json'),
      coreHook: join(ws.coreImpl, '.git', 'hooks', 'pre-commit'),
      coreRelease: join(ws.coreReleases, 'x'),
    };
    const behavior = `
const { spawnSync } = await import('node:child_process');
const net = await import('node:net');
const path = await import('node:path');
const results = { writes: {} };
for (const [name, file] of Object.entries(${JSON.stringify(writes)})) {
  try { fs.writeFileSync(file, 'x', { flag: 'a' }); results.writes[name] = 'written'; } catch (e) { results.writes[name] = e.code; }
}
const id = process.env.OGW_AGENT_KEY.split('.')[0];
const ogw = (args, env = process.env) => {
  const r = spawnSync(process.execPath, [${JSON.stringify(cliEntry())}, ...args], { encoding: 'utf8', env, input: '' });
  return { code: r.status, out: r.stdout, err: r.stderr };
};
results.help = ogw(['input', '--help']);
results.jobStatus = ogw(['job', 'status', id]);
results.jobWait = ogw(['job', 'wait', id, '--timeout', '0']);
results.forged = ogw(['job', 'status', id], { ...process.env, OGW_AGENT_KEY: id + '.forged' });
results.refused = Object.fromEntries([
  ['secret', 'set', '--harness', 'huggingface'],
  ['settings', 'get', 'harness', 'humanLanguage'],
  ['check', 'nogame', '--static', '--background'],
  ['command', 'inst1', 'get_state'],
].map((args) => [args.join(' '), ogw(args)]));
results.brokerMode = (fs.statSync(path.dirname(process.env.OGW_BROKER_SOCKET)).mode & 0o777).toString(8);
results.env = { ssh: process.env.SSH_AUTH_SOCK ?? null, tmux: process.env.TMUX ?? null };
const connect = (options) => new Promise((resolve) => {
  const socket = net.connect(options);
  const timer = setTimeout(() => { socket.destroy(); resolve('timeout'); }, 1500);
  socket.on('connect', () => { clearTimeout(timer); socket.destroy(); resolve('connected'); });
  socket.on('error', (e) => { clearTimeout(timer); resolve(e.code); });
});
results.ipv4 = await connect({ host: '127.0.0.1', port: ${String(local.port)} });
results.ipv6 = await connect({ host: '::1', port: ${String(local.port)} });
results.unix = await connect({ path: ${JSON.stringify(local.unix)} });
// TEST-NET-1: never routed, so no packet reaches a real host; the profile does not deny it
results.remote = await connect({ host: '192.0.2.1', port: 9 });
fs.writeFileSync(output, JSON.stringify(results));
`;
    const fake = fakeAgentCli(ws, behavior);
    writeFileSync(join(ws.root, 'play.json'), JSON.stringify({ instance: 'inst1', playGuide: join(root, 'play-guide.md'), moment: null }));
    const env = { ...fake.env, SSH_AUTH_SOCK: join(dir, 'agent.sock'), TMUX: `${join(dir, 'tmux-1', 'default')},1,0` };
    const outside = await ogw(ws, ['input', '--help']);
    let id = '';
    try {
      const run = await runAgent(ws, ['play', '--game', 'g', '--input', join(ws.root, 'play.json')], env, root);
      id = run.id;
      expect(run.waited.code).toBe(0);
    } finally {
      local.close();
      await rm(probe, { force: true });
    }
    const results = JSON.parse(readFileSync(join(root, 'records/loops/r1/play-1-1.md'), 'utf8')) as Record<string, unknown>;
    expect(results.writes).toEqual(Object.fromEntries(Object.keys(writes).map((name) => [name, 'EPERM'])));
    expect(results.help).toEqual({ code: 0, out: outside.stdout, err: '' });
    expect(results.jobStatus).toEqual({ code: 0, out: 'running\n', err: '' });
    expect(results.jobWait).toEqual({ code: 75, out: 'running\n', err: '' });
    expect(results.forged).toMatchObject({ code: 1, out: '' });
    expect((results.forged as { err: string }).err).toContain('is not the key of this agent');
    // commands that are not broker commands do not run
    for (const refused of Object.values(results.refused as Record<string, { code: number; out: string; err: string }>)) {
      expect(refused).toMatchObject({ code: 1, out: '' });
      expect(refused.err).toContain('is not a command of the play and judge agents');
    }
    const commandsRun = readdirSync(jobs)
      .filter((name) => name.endsWith('.json'))
      .map((name) => (JSON.parse(readFileSync(join(jobs, name), 'utf8')) as { command?: unknown }).command);
    expect(commandsRun).not.toContain('check');
    expect(results.brokerMode).toBe('700');
    expect(results.env).toEqual({ ssh: null, tmux: null });
    expect([results.ipv4, results.ipv6, results.unix]).toEqual(['EPERM', 'EPERM', 'EPERM']);
    expect(results.remote).not.toBe('EPERM');
    // the broker wrote the run log as for any agent, and is gone with the agent
    const runLog = JSON.parse(sh(root, 'git', ['show', 'loop/r1:records/loops/r1/play-1-1-runs.json'])) as { runs: { command: string; job?: string }[] };
    expect(runLog.runs.map((entry) => entry.command)).toEqual(['ogw input --help', `ogw job status ${id}`, `ogw job wait ${id} --timeout 0`]);
    expect(existsSync(join(jobs, 'brokers', id))).toBe(false);
  }, 120_000);
});
