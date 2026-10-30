// The process a play or judge broker keeps in the broker sandbox for its frequent commands (`broker.ts`
// `WORKER_COMMANDS`): it runs one forwarded command at a time in itself, so a call does not start node and load the
// CLI again. Requests come on stdin as JSON lines `{"argv": [...], "cwd": "<absolute path>"}`, and the answer to a
// stdin request of the running command as `{"stdin": "<text>"}`. Every message of a command goes to fd 3 as a
// `BrokerMessage` line; `{"exit": <code>}` ends it.
import { writeSync } from 'node:fs';
import { lineReader, type BrokerMessage } from '../../../lib/broker-client.ts';
import type { CliIo } from '../../../lib/cli.ts';

interface WorkerCall {
  argv: string[];
  cwd: string;
}

function send(message: BrokerMessage): void {
  writeSync(3, `${JSON.stringify(message)}\n`);
}

/** Runs the forwarded commands one after another until stdin ends. */
export async function runBrokerWorker(env: NodeJS.ProcessEnv): Promise<number> {
  const [{ commandsFor }, { runCli }] = await Promise.all([import('../../lazy.ts'), import('../../../lib/cli.ts')]);
  const queue: WorkerCall[] = [];
  let answer: ((text: string) => void) | null = null;
  let running = false;
  let ended = false;
  let done: () => void = () => undefined;
  const finished = new Promise<void>((resolvePromise) => {
    done = resolvePromise;
  });

  const runOne = async (call: WorkerCall): Promise<void> => {
    // a command that resolves a path without a base resolves it against the cwd of its call
    process.chdir(call.cwd);
    const io: CliIo = {
      cwd: call.cwd,
      env,
      stdin: () => {
        send({ stdin: true });
        return new Promise((resolvePromise) => {
          answer = resolvePromise;
        });
      },
      stdout: (text) => {
        send({ stdout: text });
      },
      stderr: (text) => {
        send({ stderr: text });
      },
      terminal: undefined,
    };
    let code: number;
    try {
      code = await runCli(await commandsFor(call.argv[0]), call.argv, io);
    } catch (error) {
      io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      code = 1;
    }
    answer = null;
    send({ exit: code });
  };

  const pump = async (): Promise<void> => {
    if (running) return;
    running = true;
    for (let call = queue.shift(); call !== undefined; call = queue.shift()) await runOne(call);
    running = false;
    if (ended) done();
  };

  const read = lineReader((text) => {
    let message: { argv?: unknown; cwd?: unknown; stdin?: unknown };
    try {
      message = JSON.parse(text) as typeof message;
    } catch {
      return;
    }
    if (Array.isArray(message.argv) && message.argv.every((arg) => typeof arg === 'string') && typeof message.cwd === 'string') {
      queue.push({ argv: message.argv, cwd: message.cwd });
      void pump();
    } else if (typeof message.stdin === 'string' && answer !== null) {
      const give = answer;
      answer = null;
      give(message.stdin);
    }
  });
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', read);
  process.stdin.on('end', () => {
    ended = true;
    if (!running) done();
  });
  await finished;
  return 0;
}
