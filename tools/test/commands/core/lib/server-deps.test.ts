import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installServerDependencies } from '../../../../src/commands/core/lib/server-tests.ts';

/** A checkout with `server/package-lock.json` and a fake npm that logs its calls and writes `node_modules/.package-lock.json`. */
function setup(): { checkout: string; env: NodeJS.ProcessEnv; calls: () => string[] } {
  const root = mkdtempSync(join(tmpdir(), 'ogw-server-deps-'));
  const checkout = join(root, 'checkout');
  mkdirSync(join(checkout, 'server'), { recursive: true });
  writeFileSync(join(checkout, 'server', 'package-lock.json'), '{}\n');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const log = join(root, 'npm.log');
  writeFileSync(log, '');
  writeFileSync(
    join(bin, 'npm'),
    `#!/bin/sh\necho "$PWD $*" >> ${log}\n[ -n "$FAKE_NPM_FAIL" ] && { echo no >&2; exit 3; }\nmkdir -p node_modules && echo '{}' > node_modules/.package-lock.json\n`,
  );
  chmodSync(join(bin, 'npm'), 0o755);
  return { checkout, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` }, calls: () => readFileSync(log, 'utf8').split('\n').filter((l) => l !== '') };
}

describe('installServerDependencies', () => {
  it('runs npm ci in server/ only when node_modules is missing or older than the lock', async () => {
    const { checkout, env, calls } = setup();
    await installServerDependencies(checkout, env);
    expect(calls()).toEqual([`${join(checkout, 'server')} ci --no-audit --no-fund`]);
    await installServerDependencies(checkout, env);
    expect(calls()).toHaveLength(1);
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(checkout, 'server', 'package-lock.json'), later, later);
    await installServerDependencies(checkout, env);
    expect(calls()).toHaveLength(2);
  });

  it('removes a node_modules link first, so it installs its own and writes nothing into the linked folder', async () => {
    const { checkout, env, calls } = setup();
    const other = join(checkout, '..', 'main-node_modules');
    mkdirSync(join(other, 'dep'), { recursive: true });
    // the other checkout's install is newer than this lock: through the link this checkout would look installed
    writeFileSync(join(other, '.package-lock.json'), '{}\n');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(other, '.package-lock.json'), later, later);
    symlinkSync(other, join(checkout, 'server', 'node_modules'), 'dir');
    await installServerDependencies(checkout, env);
    expect(calls()).toEqual([`${join(checkout, 'server')} ci --no-audit --no-fund`]);
    expect(lstatSync(join(checkout, 'server', 'node_modules')).isSymbolicLink()).toBe(false);
    expect(existsSync(join(other, 'dep'))).toBe(true);
  });

  it('runs one npm ci for runs that start together', async () => {
    const { checkout, env, calls } = setup();
    await Promise.all([1, 2, 3].map(() => installServerDependencies(checkout, env)));
    expect(calls()).toHaveLength(1);
  });

  it('does nothing without server/package-lock.json and fails with the npm output', async () => {
    const { checkout, env, calls } = setup();
    await installServerDependencies(join(checkout, 'none'), env);
    expect(calls()).toEqual([]);
    await expect(installServerDependencies(checkout, { ...env, FAKE_NPM_FAIL: '1' })).rejects.toThrow('server: npm ci failed (3)\nno');
  });
});
