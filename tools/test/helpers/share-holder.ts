// A holder of a share of a `withShare` ledger in a process of its own, and the markers that tell how much all holders
// of a ledger hold at once.
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SHARES = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'lib', 'shares.ts')).href;

const SCRIPT = `
import { withShare } from ${JSON.stringify(SHARES)};
import { readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [dir, total, share, markers] = process.argv.slice(2);
await withShare(dir, Number(total), Number(share), async () => {
  const mine = join(markers, share + '-' + String(process.pid));
  writeFileSync(mine, '');
  const sum = readdirSync(markers).reduce((n, name) => n + Number(name.split('-')[0]), 0);
  process.stdout.write('held ' + String(sum) + '\\n');
  await new Promise((resolve) => { process.stdin.on('end', resolve); process.stdin.resume(); });
  rmSync(mine);
});
process.stdout.write('released\\n');
`;

/**
 * Leaves a marker of `share` in `markers` while `fn` runs, and passes it the sum of the shares of all markers there when
 * it starts: more than the total of the ledger means holders held more than it at once.
 */
export async function marked<T>(markers: string, share: number, fn: (sum: number) => Promise<T>): Promise<T> {
  const mine = join(markers, `${String(share)}-${String(process.pid)}-${String(Math.random()).slice(2)}`);
  writeFileSync(mine, '');
  try {
    return await fn(readdirSync(markers).reduce((n, name) => n + Number(name.split('-')[0]), 0));
  } finally {
    rmSync(mine);
  }
}

/** A new folder for the markers of a ledger. */
export function markersDir(): string {
  const dir = join(mkdtempSync(join(tmpdir(), 'ogw-share-markers-')), 'markers');
  mkdirSync(dir);
  return dir;
}

export interface ShareHolder {
  pid: number;
  /** Resolves when the child holds its share, with the sum of the markers it saw then (`marked`). */
  held: Promise<number>;
  /** Whether the child holds its share now. */
  holding: () => boolean;
  /** Lets the child let go of its share and end. */
  release: () => void;
  /** Ends the child at once, without letting go of its share. */
  kill: () => void;
  /** Resolves when the child ended. */
  exited: Promise<void>;
}

/** A child process that takes `share` of `total` of the ledger `dir` (`withShare`) and holds it until `release`. */
export function holdInChild(dir: string, total: number, share: number, markers: string): ShareHolder {
  const script = join(mkdtempSync(join(tmpdir(), 'ogw-share-holder-')), 'holder.mjs');
  writeFileSync(script, SCRIPT);
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', script, dir, String(total), String(share), markers], { stdio: ['pipe', 'pipe', 'inherit'] });
  let out = '';
  let holding = false;
  const held = new Promise<number>((resolveHeld, reject) => {
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk.toString('utf8');
      const sum = /^held (\d+)$/m.exec(out)?.[1];
      if (sum !== undefined && !holding && !out.includes('released')) {
        holding = true;
        resolveHeld(Number(sum));
      }
      if (out.includes('released')) holding = false;
    });
    child.once('exit', (code) => {
      holding = false;
      reject(new Error(`share holder ended with ${String(code)} before it held its share`));
    });
  });
  held.catch(() => undefined);
  const exited = new Promise<void>((resolveExit) => child.once('exit', () => {
    rmSync(dirname(script), { recursive: true, force: true });
    resolveExit();
  }));
  return { pid: child.pid ?? 0, held, holding: () => holding, release: () => child.stdin.end(), kill: () => child.kill('SIGKILL'), exited };
}
