// Runs the fake Godot client of the instance tests with the launch values of a JSON file
// (the DEV export of a build-time check): `node fake-launch.ts <launch values file>`.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.argv = [process.argv[0] ?? 'node', 'fake-godot', '--', `--launch-values=${process.argv[2] ?? ''}`];
await import(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'instance', 'fakes', 'fake-godot.mjs'));
