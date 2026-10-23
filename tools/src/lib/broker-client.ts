// The `ogw` side of the play and judge broker (ogw.md `## agent`): inside the sandbox, `ogw` does not run a
// command itself but sends it to the broker of its agent over a unix socket. Kept free of the command modules, so a
// forwarded call loads nothing else.
import { connect } from 'node:net';
import { AGENT_KEY_ENV } from './jobs.ts';

/** The environment variable that gives a sandboxed agent CLI the path of its broker socket. */
export const BROKER_ENV = 'OGW_BROKER_SOCKET';

/** First argument of the process the broker starts for a forwarded command: asks for stdin through fd 3. */
export const BROKER_RUN = '__broker-run';

/** The broker's request for stdin, written to fd 3 by the process that runs the forwarded command. */
export const STDIN_REQUEST = 'stdin\n';

/** The first message of a connection: one JSON line. Later client lines are `{"stdin": "<text>"}`. */
export interface BrokerRequest {
  argv: string[];
  cwd: string;
  key: string;
}

/** A broker line: a chunk of stdout or stderr, a request for stdin, or the exit code, which ends the connection. */
export interface BrokerMessage {
  stdout?: string;
  stderr?: string;
  stdin?: true;
  exit?: number;
}

export interface BrokerIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdin: () => Promise<string>;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

/** Splits a stream of text into lines and calls `line` for each complete one. */
export function lineReader(line: (text: string) => void): (chunk: string) => void {
  let buffer = '';
  return (chunk) => {
    buffer += chunk;
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const text = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      line(text);
    }
  };
}

/**
 * Sends one `ogw` invocation (argv, cwd, the agent key) to the broker at `socket`, writes what the broker sends
 * back to stdout and stderr, gives stdin when the command reads it, and returns the command's exit code.
 */
export function forwardToBroker(socket: string, argv: readonly string[], io: BrokerIo): Promise<number> {
  return new Promise((resolvePromise) => {
    let ended = false;
    const end = (code: number, message?: string): void => {
      if (ended) return;
      ended = true;
      if (message !== undefined) io.stderr(`${message}\n`);
      connection.destroy();
      resolvePromise(code);
    };
    const connection = connect(socket);
    connection.setEncoding('utf8');
    connection.on('connect', () => {
      const request: BrokerRequest = { argv: [...argv], cwd: io.cwd, key: io.env[AGENT_KEY_ENV] ?? '' };
      connection.write(`${JSON.stringify(request)}\n`);
    });
    connection.on(
      'data',
      lineReader((text) => {
        let message: BrokerMessage;
        try {
          message = JSON.parse(text) as BrokerMessage;
        } catch {
          end(1, 'the ogw broker sent a line that is not JSON');
          return;
        }
        if (typeof message.stdout === 'string') io.stdout(message.stdout);
        if (typeof message.stderr === 'string') io.stderr(message.stderr);
        if (message.stdin === true) {
          void io.stdin().then((stdin) => connection.write(`${JSON.stringify({ stdin })}\n`));
        }
        if (typeof message.exit === 'number') end(message.exit);
      }),
    );
    connection.on('error', (error) => {
      end(1, `cannot reach the ogw broker at ${socket}: ${error.message}`);
    });
    connection.on('close', () => {
      end(1, 'the ogw broker closed the connection before the command ended');
    });
  });
}
