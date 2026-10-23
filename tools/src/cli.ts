#!/usr/bin/env node
import { BROKER_ENV, forwardToBroker } from './lib/broker-client.ts';
import { readAll } from './lib/stdin.ts';

const argv = process.argv.slice(2);
const io = {
  cwd: process.cwd(),
  env: process.env,
  stdin: () => readAll(process.stdin),
  stdout: (text: string) => process.stdout.write(text),
  stderr: (text: string) => process.stderr.write(text),
  terminal: () => process.stdin.isTTY && process.stdout.isTTY,
};

/** Runs the command in this process: everywhere except inside a play or judge sandbox. */
async function runHere(): Promise<number> {
  const [{ commands }, { runCli }] = await Promise.all([import('./commands/index.ts'), import('./lib/cli.ts')]);
  return runCli(commands, argv, io);
}

// inside a play or judge sandbox every command goes to the agent's broker (ogw.md `## agent`)
const broker = process.env[BROKER_ENV];
const code = broker !== undefined && broker !== '' ? await forwardToBroker(broker, argv, io) : await runHere();
process.stdout.write('', () => process.exit(code));
