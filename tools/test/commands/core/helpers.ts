import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { TestWorkspace } from '../../helpers/workspace.ts';

/** Writes an executable node script `name` into `<ws.root>/bin` and returns the folder. */
export function fakeBin(ws: TestWorkspace, name: string, body: string): string {
  const dir = join(ws.root, 'bin');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(file, 0o755);
  return dir;
}

/** env with the fake bin folder first on PATH. */
export function pathEnv(ws: TestWorkspace, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PATH: `${join(ws.root, 'bin')}:${process.env.PATH ?? ''}`, ...extra };
}

export interface FakeGh {
  env: NodeJS.ProcessEnv;
  /** Argument lists of every call. */
  calls(): string[][];
  /** Releases created with `gh release create`: tag to asset file names. */
  created(): Record<string, string[]>;
}

/**
 * A fake `gh`: `releases` maps a tag to a folder whose files are its assets. Supports `release list`,
 * `release view`, `release download`, `release create`. `FAKE_GH_FAIL=<subcommand>` makes that call fail.
 */
export function fakeGh(ws: TestWorkspace, releases: Record<string, string>): FakeGh {
  const state = join(ws.root, 'gh-state.json');
  writeFileSync(state, JSON.stringify({ releases, calls: [], created: {} }));
  fakeBin(ws, 'gh', `
const fs = require('node:fs'); const path = require('node:path');
const statePath = ${JSON.stringify(state)};
const s = JSON.parse(fs.readFileSync(statePath, 'utf8'));
const args = process.argv.slice(2);
s.calls.push(args);
const save = () => fs.writeFileSync(statePath, JSON.stringify(s));
const opt = (name) => args[args.indexOf(name) + 1];
save();
if (process.env.FAKE_GH_FAIL === args[1]) { process.stderr.write('boom'); process.exit(4); }
if (args[0] !== 'release') process.exit(9);
if (args[1] === 'list') { process.stdout.write(JSON.stringify(Object.keys(s.releases).map((tagName) => ({ tagName })))); process.exit(0); }
const tag = args[2];
if (args[1] === 'view') { if (s.releases[tag] || s.created[tag]) process.exit(0); process.stderr.write('release not found'); process.exit(1); }
if (args[1] === 'download') {
  const dir = opt('--dir'); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(s.releases[tag])) fs.copyFileSync(path.join(s.releases[tag], f), path.join(dir, f));
  process.exit(0);
}
if (args[1] === 'create') {
  const files = []; for (let i = 3; i < args.length && !args[i].startsWith('--'); i++) files.push(path.basename(args[i]));
  s.created[tag] = files; save();
  if (process.env.FAKE_GH_CREATE_THEN_FAIL) { process.stderr.write('upload interrupted'); process.exit(4); }
  process.exit(0);
}
process.exit(9);
`);
  return {
    env: pathEnv(ws),
    calls: () => (JSON.parse(readFileSync(state, 'utf8')) as { calls: string[][] }).calls,
    created: () => (JSON.parse(readFileSync(state, 'utf8')) as { created: Record<string, string[]> }).created,
  };
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** A release folder with `files` and a matching `manifest.json`. */
export function makeReleaseDir(dir: string, version: string, files: Record<string, string>, coreSchemaVersion = 1): string {
  mkdirSync(dir, { recursive: true });
  const assets: Record<string, string> = {};
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content);
    assets[name] = sha256(content);
  }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify({ version, assets, coreSchemaVersion }));
  return dir;
}

export function readJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function writeFiles(root: string, files: Record<string, string | object>): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
  }
}

export function fileExists(path: string): boolean {
  return existsSync(path);
}
