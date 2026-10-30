// The broker worker: the process a play or judge broker keeps for its frequent commands.
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startBroker, workerRuns, type Broker } from '../../../src/commands/agent/lib/broker.ts';
import { newTempFolder } from '../../../src/commands/agent/lib/files.ts';
import { BROKER_RUN, BROKER_WORKER, forwardToBroker, type BrokerIo } from '../../../src/lib/broker-client.ts';
import { cliEntry } from '../../../src/lib/paths.ts';
import { jobWorkspace, writeJob } from '../job/helpers.ts';

interface Captured {
  code: number;
  stdout: string;
  stderr: string;
}

const KEY = 'ag1.nonce';

async function forward(socket: string, argv: string[], stdin = ''): Promise<Captured> {
  const out: Captured = { code: -1, stdout: '', stderr: '' };
  const io: BrokerIo = {
    cwd: process.cwd(),
    env: { OGW_AGENT_KEY: KEY },
    stdin: () => Promise.resolve(stdin),
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

/** A call whose client stays connected until the test destroys the socket. */
function openCall(socket: string, argv: string[]): Promise<Socket> {
  return new Promise((resolvePromise, reject) => {
    const client = connect(socket, () => {
      client.write(`${JSON.stringify({ argv, cwd: process.cwd(), key: KEY })}\n`);
      resolvePromise(client);
    });
    client.on('error', reject);
  });
}

const wait = (ms: number): Promise<void> => new Promise((resolvePromise) => setTimeout(resolvePromise, ms));

/**
 * A worker that speaks the worker protocol: it prints its pid and the call, asks for stdin on `<command> ask`, never
 * ends `<command> hang`, and exits on `<command> die`.
 */
const FAKE_WORKER = [
  '-e',
  `const fs = require('node:fs');
const out = (m) => fs.writeSync(3, JSON.stringify(m) + '\\n');
let buffer = '';
let waiting = null;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  for (let end = buffer.indexOf('\\n'); end >= 0; end = buffer.indexOf('\\n')) {
    const message = JSON.parse(buffer.slice(0, end));
    buffer = buffer.slice(end + 1);
    if (typeof message.stdin === 'string' && waiting) { const give = waiting; waiting = null; give(message.stdin); continue; }
    const argv = message.argv;
    if (argv[1] === 'ask') { out({ stdin: true }); waiting = (text) => { out({ stdout: 'got ' + text }); out({ exit: 0 }); }; }
    else if (argv[1] === 'hang') {}
    else if (argv[1] === 'die') process.exit(3);
    else { out({ stdout: 'worker ' + process.pid + ' ' + argv.join(' ') }); out({ exit: 0 }); }
  }
});`,
];

/** The command of a call the worker does not run: prints its argv. */
const spawned = (argv: readonly string[]): { cmd: string; args: string[] } => ({
  cmd: process.execPath,
  args: ['-e', "process.stdout.write('spawned ' + process.argv.slice(1).join(' '))", ...argv],
});

async function brokerWith(worker: { cmd: string; args: string[] } | undefined, command = spawned): Promise<{ socket: string; broker: Broker }> {
  const ws = jobWorkspace();
  writeJob(ws.jobs, { id: 'ag1', command: 'agent', supervisorPid: process.pid, meta: { role: 'judge', runLog: join(ws.root, 'runs.json') } });
  const socket = join(await newTempFolder('ogw-broker-'), 'b', 's');
  const broker = await startBroker({ socket, key: KEY, command, ...(worker ? { worker } : {}), env: { ...ws.env, OGW_AGENT_KEY: KEY } });
  return { socket, broker };
}

const pidOf = (out: Captured): string => /^worker (\d+) /.exec(out.stdout)?.[1] ?? '';

describe('broker worker', () => {
  it('runs the frequent commands, not a background start or another command', () => {
    for (const argv of [['step', 'i1', '50'], ['input', 'i1', 'tap', '1', '2'], ['capture', 'i1'], ['telemetry', 'i1'], ['log', 'i1'], ['frames', 'i1'], ['step-mode', 'i1', 'on']]) {
      expect(workerRuns(argv)).toBe(true);
    }
    for (const argv of [['step', 'i1', '50', '--background'], ['telemetry', 'compare', 'a'], ['instance', 'wait', 'i1'], ['job', 'wait', 'j1'], ['job', 'status', 'j1']]) {
      expect(workerRuns(argv)).toBe(false);
    }
  });

  it('runs the calls of the frequent commands one after another in one process, gives it stdin when asked, and starts a process for the others', async () => {
    const { socket, broker } = await brokerWith({ cmd: process.execPath, args: FAKE_WORKER });
    try {
      const first = await forward(socket, ['step', 'i1', '50']);
      const second = await forward(socket, ['input', 'i1', 'tap']);
      expect(first).toMatchObject({ code: 0, stderr: '' });
      expect(first.stdout).toMatch(/^worker \d+ step i1 50$/);
      expect(pidOf(second)).toBe(pidOf(first));
      expect(await forward(socket, ['step', 'ask'], 'hello')).toMatchObject({ code: 0, stdout: 'got hello' });
      expect(await forward(socket, ['job', 'status', 'j1'])).toMatchObject({ code: 0, stdout: 'spawned job status j1' });
      expect((await forward(socket, ['step', 'i1', '50', '--background'])).stdout).toBe('spawned step i1 50 --background');
      expect(pidOf(await forward(socket, ['step', 'i1', '50']))).toBe(pidOf(first));
    } finally {
      await broker.close();
    }
  });

  it('starts a process for a call while the worker runs one, and starts a new worker after a caller went away', async () => {
    const { socket, broker } = await brokerWith({ cmd: process.execPath, args: FAKE_WORKER });
    try {
      const before = pidOf(await forward(socket, ['step', 'i1', '50']));
      const hanging = await openCall(socket, ['step', 'hang']);
      await wait(200);
      expect((await forward(socket, ['step', 'i1', '50'])).stdout).toBe('spawned step i1 50');
      // the caller of the running call goes away: its command cannot be stopped alone, so the worker is killed
      hanging.destroy();
      await wait(200);
      const after = pidOf(await forward(socket, ['step', 'i1', '50']));
      expect(after).not.toBe('');
      expect(after).not.toBe(before);
    } finally {
      await broker.close();
    }
  });

  it('fails the call of a worker that ended, and runs the next call on a new worker', async () => {
    const { socket, broker } = await brokerWith({ cmd: process.execPath, args: FAKE_WORKER });
    try {
      const before = pidOf(await forward(socket, ['step', 'i1', '50']));
      const died = await forward(socket, ['step', 'die']);
      expect(died.code).toBe(1);
      expect(died.stderr).toContain('ogw broker: the broker worker ended');
      const after = pidOf(await forward(socket, ['step', 'i1', '50']));
      expect(after).not.toBe('');
      expect(after).not.toBe(before);
    } finally {
      await broker.close();
    }
  });

  it('gives the same output and exit code as a process of its own for each call, call after call', async () => {
    const real = (argv: readonly string[]): { cmd: string; args: string[] } => ({ cmd: process.execPath, args: [cliEntry(), BROKER_RUN, ...argv] });
    const own = await brokerWith(undefined, real);
    const kept = await brokerWith({ cmd: process.execPath, args: [cliEntry(), BROKER_WORKER] }, real);
    try {
      for (const argv of [['step', '--help'], ['capture', 'no-such-instance'], ['telemetry', 'no-such-instance', '--summary'], ['input', 'no-such-instance', 'tap', '1', '2'], ['step', '--help']]) {
        const expected = await forward(own.socket, argv);
        const got = await forward(kept.socket, argv);
        expect(got).toEqual(expected);
        expect(`${got.stdout}${got.stderr}`).not.toBe('');
      }
    } finally {
      await own.broker.close();
      await kept.broker.close();
    }
  });

  it('passes stdin to a command that reads it as it comes, chunk by chunk, on a process of its own and on the worker', async () => {
    const real = (argv: readonly string[]): { cmd: string; args: string[] } => ({ cmd: process.execPath, args: [cliEntry(), BROKER_RUN, ...argv] });
    const own = await brokerWith(undefined, real);
    const kept = await brokerWith({ cmd: process.execPath, args: [cliEntry(), BROKER_WORKER] }, real);
    try {
      for (const socket of [own.socket, kept.socket]) {
        let stdout = '';
        const lines = (): number => stdout.split('\n').filter((line) => line !== '').length;
        const until = async (n: number): Promise<void> => {
          for (let i = 0; i < 200 && lines() < n; i++) await wait(25);
        };
        // each line is sent only after the answer of the line before came back: a broker that waited for the end of
        // stdin would never answer
        async function* chunks(): AsyncIterable<string> {
          yield 'step\n';
          await until(1);
          yield 'input tap 1 2\n';
          await until(2);
        }
        const io: BrokerIo = {
          cwd: process.cwd(),
          env: { OGW_AGENT_KEY: KEY },
          stdin: () => Promise.reject(new Error('stdin read all at once')),
          stdinChunks: chunks,
          stdout: (text) => {
            stdout += text;
          },
          stderr: () => undefined,
        };
        const code = await forwardToBroker(socket, ['step', 'no-such-instance', '50', '--stream'], io);
        expect(code).toBe(1);
        expect(stdout.trimEnd().split('\n').map((line) => JSON.parse(line) as unknown)).toEqual([
          { exit: 1, error: 'instance no-such-instance is not running' },
          { exit: 1, error: 'instance no-such-instance is not running' },
        ]);
      }
    } finally {
      await own.broker.close();
      await kept.broker.close();
    }
  });
});
