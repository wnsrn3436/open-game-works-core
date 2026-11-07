import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordJobEnd } from '../../src/lib/agentctx.ts';
import { forwardToBroker, type BrokerIo } from '../../src/lib/broker-client.ts';
import { removeContainer, startPostgresContainer } from '../../src/lib/docker-postgres.ts';
import { isNotFound } from '../../src/lib/fsx.ts';
import { resolveCoreImpl } from '../../src/lib/game.ts';
import { endJobsOfAgent, readJob } from '../../src/lib/jobs.ts';
import { isAlive, killRecordedGroup, killTree, run, SpawnError, which } from '../../src/lib/proc.ts';
import { withReader } from '../../src/lib/rwlock.ts';
import { child } from '../../src/lib/schema-nav.ts';
import { secretFilesDir } from '../../src/lib/secret-files.ts';
import { scanFiles } from '../../src/lib/secret-scan.ts';
import { fileSecretStore, KeyringError, linuxSecretStore, MOVED_MARKER_FILE, type SecretEntries } from '../../src/lib/secrets.ts';
import { jobWorkspace, writeJob } from '../commands/job/helpers.ts';
import { makeWorkspace } from '../helpers/workspace.ts';

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: on purpose`), { code });
}

function temp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

const servers: Server[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) server.close();
});

describe('proc', () => {
  it('rejects a program that cannot start with a SpawnError that keeps the code, and which fails when its finder cannot run', async () => {
    const failure: unknown = await run('ogw-no-such-program', [], { timeoutMs: 10_000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SpawnError);
    expect(isNotFound(failure)).toBe(true);
    expect((failure as Error).message).toMatch(/^cannot run ogw-no-such-program: spawn ogw-no-such-program ENOENT$/);
    // a program that is not on PATH is null; a finder that cannot run is no answer
    expect(await which('ogw-no-such-program')).toBeNull();
    await expect(which('node', { ...process.env, PATH: temp('ogw-empty-path-') })).rejects.toBeInstanceOf(SpawnError);
    // an argument spawn refuses before any system call is no failure to start the program
    const invalid: unknown = await run('node', ['a\0b'], { timeoutMs: 10_000 }).catch((error: unknown) => error);
    expect(invalid).toBeInstanceOf(TypeError);
    expect(invalid).not.toBeInstanceOf(SpawnError);
  });

  it('takes only a gone process as gone when it signals, and throws a signal that is not permitted', () => {
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementation(() => {
      throw errno('ESRCH');
    });
    expect(() => {
      killTree(999_999);
    }).not.toThrow();
    expect(isAlive(999_999)).toBe(false);
    expect(() => {
      killRecordedGroup(999_999, 'never', 'SIGTERM');
    }).not.toThrow();
    kill.mockImplementation(() => {
      throw errno('EPERM');
    });
    expect(() => {
      killTree(999_999);
    }).toThrow('EPERM');
    // a process of another user is there
    expect(isAlive(999_999)).toBe(true);
    // no process group of that id, and the process alone may not be signalled
    kill.mockImplementation((pid: number) => {
      throw errno(pid < 0 ? 'ESRCH' : 'EPERM');
    });
    expect(() => {
      killTree(999_999);
    }).toThrow('EPERM');
    kill.mockImplementation(() => {
      throw errno('EINVAL');
    });
    expect(() => isAlive(999_999)).toThrow('EINVAL');
    // the leader is gone (signal 0 finds no process) and the signal to its group is not permitted
    kill.mockImplementation((pid: number, signal?: string | number) => {
      throw errno(signal === 0 || pid > 0 ? 'ESRCH' : 'EPERM');
    });
    expect(() => {
      killRecordedGroup(999_999, 'never', 'SIGTERM');
    }).toThrow('EPERM');
  });
});

describe('jobs', () => {
  it('ends every job of an agent before it throws the end that failed, and keeps the index', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'agk', command: 'agent', supervisorPid: null });
    writeJob(ws.jobs, { id: 'bad1', agentJob: 'agk', pid: 999_999, pidStartedAt: 'never', supervisorPid: null });
    writeJob(ws.jobs, { id: 'ok1', agentJob: 'agk', pid: null, supervisorPid: null });
    const kill = vi.spyOn(process, 'kill');
    kill.mockImplementation((pid: number, signal?: string | number) => {
      throw errno(signal === 0 || pid > 0 ? 'ESRCH' : 'EPERM');
    });
    await expect(endJobsOfAgent('agk', ws.env)).rejects.toThrow(/^cannot end the jobs of agent agk: job bad1: EPERM/);
    kill.mockRestore();
    expect((await readJob('ok1', ws.env)).status).toBe('failed');
    expect(existsSync(join(ws.jobs, 'agent-jobs', 'agk', 'bad1'))).toBe(true);
  });

  it('ends nothing for an agent that started no job, and throws an index that cannot be read', async () => {
    const ws = jobWorkspace();
    await expect(endJobsOfAgent('none', ws.env)).resolves.toBeUndefined();
    mkdirSync(join(ws.jobs, 'agent-jobs'), { recursive: true });
    writeFileSync(join(ws.jobs, 'agent-jobs', 'filed'), '');
    await expect(endJobsOfAgent('filed', ws.env)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('fills no run log for an agent job that is gone, and throws an agent job record that cannot be read', async () => {
    const ws = jobWorkspace();
    writeJob(ws.jobs, { id: 'bgx', command: 'core test', agentJob: 'agx', status: 'done', exitCode: 0, endedAt: 9 });
    await expect(recordJobEnd('bgx', ws.env)).resolves.toBeUndefined();
    writeFileSync(join(ws.jobs, 'agx.json'), '{ not json');
    await expect(recordJobEnd('bgx', ws.env)).rejects.toThrow(/invalid JSON/);
  });
});

describe('game', () => {
  it('fails to find the core checkout when git cannot run, instead of taking the main checkout', async () => {
    const ws = makeWorkspace();
    const settings = { ...ws.env, PATH: temp('ogw-empty-path-') };
    const workspace = { coreImpl: ws.coreImpl, worktrees: ws.worktrees } as Parameters<typeof resolveCoreImpl>[0];
    await expect(resolveCoreImpl(workspace, ws.root, settings)).rejects.toBeInstanceOf(SpawnError);
    // with git the folder that is in no worktree of the core repo gives the main checkout
    await expect(resolveCoreImpl(workspace, ws.root, ws.env)).resolves.toBe(ws.coreImpl);
  });
});

describe('rwlock', () => {
  it('fails a reader on a writers folder that cannot be read, and takes the lock again on the next reader', async () => {
    const base = join(temp('ogw-rwlock-'), 'lock');
    writeFileSync(`${base}-writers`, '');
    await expect(withReader({ base, waitMs: 5000 }, () => Promise.resolve('read'))).rejects.toMatchObject({ code: 'ENOTDIR' });
    rmSync(`${base}-writers`);
    await expect(withReader({ base, waitMs: 5000 }, () => Promise.resolve('read'))).resolves.toBe('read');
  });
});

describe('schema navigation', () => {
  it('throws a patternProperties pattern that is no regular expression', () => {
    const root = { patternProperties: { '^[a-z]+$': { type: 'string' }, '(': { type: 'number' } } };
    expect(() => child([{ node: root, root }], 'key')).toThrow(SyntaxError);
    const valid = { patternProperties: { '^[a-z]+$': { type: 'string' } } };
    expect(child([{ node: valid, root: valid }], 'key')).toEqual([{ node: { type: 'string' }, root: valid }]);
  });
});

describe('secret files', () => {
  it('reads the common dir of a worktree checkout, of a checkout without commondir, and throws a commondir that cannot be read', async () => {
    const harness = temp('ogw-harness-');
    const gitDir = join(harness, 'gitdir');
    mkdirSync(gitDir);
    writeFileSync(join(harness, '.git'), `gitdir: ${gitDir}\n`);
    const env = { ...process.env, OGW_HARNESS_ROOT: harness };
    expect(await secretFilesDir(env)).toBe(join(gitDir, 'ogw-secret-files'));
    mkdirSync(join(gitDir, 'commondir'));
    await expect(secretFilesDir(env)).rejects.toMatchObject({ code: 'EISDIR' });
    const plain = temp('ogw-harness-');
    await expect(secretFilesDir({ ...process.env, OGW_HARNESS_ROOT: plain })).rejects.toThrow(/is not a git checkout/);
    writeFileSync(join(plain, 'file'), '');
    await expect(secretFilesDir({ ...process.env, OGW_HARNESS_ROOT: join(plain, 'file') })).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});

describe('secret scan', () => {
  it('passes over a listed file that is gone and fails on a file it cannot look at', async () => {
    const root = temp('ogw-scan-');
    writeFileSync(join(root, 'a.txt'), 'the token s3cr3t\n');
    symlinkSync(join(root, 'nothing'), join(root, 'dangling'));
    const needles = [{ value: Buffer.from('s3cr3t'), label: 'token' }];
    expect(await scanFiles(root, ['a.txt', 'dangling', 'removed.txt'], needles, { lines: true })).toEqual(['a.txt:1: token']);
    mkdirSync(join(root, 'closed'));
    writeFileSync(join(root, 'closed', 'b.txt'), 's3cr3t');
    chmodSync(join(root, 'closed'), 0o000);
    try {
      await expect(scanFiles(root, ['closed/b.txt'], needles, { lines: true })).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      chmodSync(join(root, 'closed'), 0o700);
    }
  });
});

describe('secret store', () => {
  it('reads the Secret Service as empty only when the keyring call fails, and throws every other error', () => {
    const throwing = (error: Error): SecretEntries => ({
      get: () => {
        throw error;
      },
      set: () => undefined,
      delete: () => undefined,
    });
    const folder = (): string => join(temp('ogw-data-'), 'secrets');
    expect(linuxSecretStore(folder(), throwing(new KeyringError('cannot read secret store: no session bus'))).get('ogw/g/DEV/x')).toBeNull();
    expect(() => linuxSecretStore(folder(), throwing(new TypeError('a defect'))).get('ogw/g/DEV/x')).toThrow('a defect');
  });

  it('moves again on a moved.json that is missing or not JSON, and throws one that cannot be read', () => {
    const empty: SecretEntries = { get: () => null, set: () => undefined, delete: () => undefined };
    const missing = join(temp('ogw-data-'), 'secrets');
    expect(linuxSecretStore(missing, empty).get('ogw/g/DEV/x')).toBeNull();
    const broken = join(temp('ogw-data-'), 'secrets');
    mkdirSync(broken, { recursive: true });
    writeFileSync(join(broken, MOVED_MARKER_FILE), '{ not json');
    expect(linuxSecretStore(broken, empty).get('ogw/g/DEV/x')).toBeNull();
    const unreadable = join(temp('ogw-data-'), 'secrets');
    mkdirSync(join(unreadable, MOVED_MARKER_FILE), { recursive: true });
    expect(() => linuxSecretStore(unreadable, empty).get('ogw/g/DEV/x')).toThrow(/^cannot read .*moved\.json: EISDIR/);
  });

  it('reads a test store file that is missing as empty and throws one that is not JSON', () => {
    const dir = temp('ogw-store-');
    expect(fileSecretStore(join(dir, 'store.json')).get('a')).toBeNull();
    writeFileSync(join(dir, 'broken.json'), '{ not json');
    expect(() => fileSecretStore(join(dir, 'broken.json')).get('a')).toThrow(SyntaxError);
  });
});

describe('docker-postgres', () => {
  it('fails to remove a container and to prune and create when docker cannot run', async () => {
    const env = { ...process.env, PATH: temp('ogw-empty-path-') };
    await expect(removeContainer('c1', env)).rejects.toBeInstanceOf(SpawnError);
    const image = `postgres:18.6@sha256:${'0'.repeat(64)}`;
    await expect(startPostgresContainer({ options: [], image, password: 'p', env })).rejects.toThrow(/^cannot run docker: spawn docker ENOENT$/);
    // a docker that runs and fails to remove is no error
    const dir = temp('ogw-docker-');
    writeFileSync(join(dir, 'docker'), '#!/bin/sh\necho "no such container" >&2\nexit 1\n');
    chmodSync(join(dir, 'docker'), 0o755);
    await expect(removeContainer('c1', { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` })).resolves.toBeUndefined();
  });
});

describe('broker client', () => {
  /** A broker that answers the request line of each call with `lines`. */
  async function broker(lines: (socket: Socket) => void): Promise<string> {
    const path = join(temp('ogw-broker-'), 's');
    const server = createServer((socket) => {
      socket.once('data', () => {
        lines(socket);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(path, resolve));
    return path;
  }

  function io(stdin: () => Promise<string>): BrokerIo & { err: string[] } {
    const err: string[] = [];
    return {
      err,
      cwd: '/',
      env: {},
      stdin,
      stdout: () => undefined,
      stderr: (text) => err.push(text),
    };
  }

  it('ends a call whose stdin cannot be read with the reason, and a call whose line is not JSON', async () => {
    const asks = await broker((socket) => socket.write('{"stdin":true}\n'));
    const failing = io(() => Promise.reject(errno('EIO')));
    expect(await forwardToBroker(asks, ['input', 'x'], failing)).toBe(1);
    expect(failing.err.join('')).toBe('cannot read stdin: EIO: on purpose\n');
    const streams = await broker((socket) => socket.write('{"stdinStream":true}\n'));
    const streaming = io(() => Promise.reject(errno('EIO')));
    expect(await forwardToBroker(streams, ['step', '--stream'], streaming)).toBe(1);
    expect(streaming.err.join('')).toBe('cannot read stdin: EIO: on purpose\n');
    const garbled = await broker((socket) => socket.write('not json\n'));
    const plain = io(() => Promise.resolve(''));
    expect(await forwardToBroker(garbled, ['input', 'x'], plain)).toBe(1);
    expect(plain.err.join('')).toBe('the ogw broker sent a line that is not JSON\n');
  });

  it('gives stdin that can be read to the broker', async () => {
    let got = '';
    const asks = await broker((socket) => {
      socket.on('data', (chunk) => {
        got += chunk.toString();
        if (got.includes('"stdin":"typed"')) socket.write('{"exit":0}\n');
      });
      socket.write('{"stdin":true}\n');
    });
    expect(await forwardToBroker(asks, ['input', 'x'], io(() => Promise.resolve('typed')))).toBe(0);
  });
});
