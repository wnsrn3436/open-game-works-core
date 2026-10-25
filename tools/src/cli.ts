#!/usr/bin/env node
import { enableCompileCache } from 'node:module';
import { BROKER_ENV, BROKER_RUN, forwardToBroker } from './lib/broker-client.ts';
import { readAll } from './lib/stdin.ts';

// later runs reuse the compiled code of the modules a run loads
enableCompileCache();

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
  // the word that picks the command: a broker run carries the command after its marker
  const word = argv[0] === BROKER_RUN ? argv[1] : argv[0];
  const [{ commandsFor }, { runCli }] = await Promise.all([import('./commands/lazy.ts'), import('./lib/cli.ts')]);
  return runCli(await commandsFor(word), argv, io);
}

// inside a play or judge sandbox every command goes to the agent's broker (ogw.md `## agent`)
const broker = process.env[BROKER_ENV];
const code = broker !== undefined && broker !== '' ? await forwardToBroker(broker, argv, io) : await runHere();
process.stdout.write('', () => process.exit(code));
