// Failures the instance commands used to turn into a default value: each now propagates or goes to the runner log,
// and the one expected failure of each place (a missing file or record) still reads as before.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stopInstance, stopInstancesOfAgent } from '../../../src/commands/instance/api.ts';
import { controlCall } from '../../../src/commands/instance/automation.ts';
import { readTable } from '../../../src/commands/instance/lib/csv.ts';
import { instanceFolder, InstanceNotFound, listRecords, readRecord, writeRecord, type InstanceRecord } from '../../../src/commands/instance/lib/records.ts';
import { Supervisor } from '../../../src/commands/instance/lib/supervisor.ts';
import { createContext } from '../../../src/lib/command.ts';
import { isAlive } from '../../../src/lib/proc.ts';

function instanceEnv(): NodeJS.ProcessEnv {
  const root = mkdtempSync(join(tmpdir(), 'ogw-inst-'));
  return { ...process.env, OGW_INSTANCES_DIR: join(root, 'instances'), OGW_PLAY_ACCESS_DIR: join(root, 'play') };
}

function record(id: string, over: Partial<InstanceRecord> = {}): InstanceRecord {
  const root = mkdtempSync(join(tmpdir(), 'ogw-inst-root-'));
  return {
    id, game: 'g', root, mainRoot: root, worktree: null, commit: '', platform: 'macos', status: 'running', error: null, failure: null,
    startedAt: Date.now(), ownerPid: 999_999, agentJob: null, supervisorPid: null, serverUrl: '', adminSecret: '', control: null,
    pids: {}, exited: {}, container: null, plan: null, ...over,
  };
}

describe('instance records', () => {
  it('lists no instance without a record folder, and fails on a record that is not JSON instead of leaving it out', async () => {
    const env = instanceEnv();
    expect(await listRecords(env)).toEqual([]);
    await writeRecord(record('good1'), env);
    expect((await listRecords(env)).map((r) => r.id)).toEqual(['good1']);
    writeFileSync(join(env.OGW_INSTANCES_DIR as string, 'bad1.json'), '{ not json');
    await expect(listRecords(env)).rejects.toThrow(/^invalid JSON in .*bad1\.json/);
  });

  it('fails a listing whose record cannot be read (a folder in its place)', async () => {
    const env = instanceEnv();
    mkdirSync(join(env.OGW_INSTANCES_DIR as string, 'odd1.json'), { recursive: true });
    await expect(listRecords(env)).rejects.toMatchObject({ code: 'EISDIR' });
  });

  it('reads a missing record as InstanceNotFound', async () => {
    await expect(readRecord('nope1', instanceEnv())).rejects.toBeInstanceOf(InstanceNotFound);
  });
});

describe('stopInstancesOfAgent', () => {
  it('stops every instance of the agent and then fails with the stops that failed', async () => {
    const env = instanceEnv();
    const ctx = createContext({ cwd: tmpdir(), env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    // git cannot run in a main root that is gone: the worktree removal of the stop of bad1 fails
    await writeRecord(record('bad1', { agentJob: 'joba', mainRoot: '/nonexistent/ogw-main', worktree: '/nonexistent/ogw-worktree' }), env);
    await writeRecord(record('good1', { agentJob: 'joba' }), env);
    await writeRecord(record('other1', { agentJob: 'jobb' }), env);
    await expect(stopInstancesOfAgent(ctx, 'joba')).rejects.toThrow(/^the instances of agent job joba were not all stopped: instance bad1: /);
    expect((await listRecords(env)).map((r) => r.id).sort()).toEqual(['bad1', 'other1']);
    // an instance whose record a stop removed meanwhile is no failure
    expect(await stopInstancesOfAgent(ctx, 'jobb')).toEqual(['other1']);
  });
});

describe('stopInstance', () => {
  it('says why it kills the processes of an instance whose live supervisor does not stop it', async () => {
    const env = instanceEnv();
    const lines: string[] = [];
    const ctx = createContext({ cwd: tmpdir(), env, stdin: () => Promise.resolve(''), stderr: (text) => lines.push(text) });
    // a live process as the supervisor, and a control port nothing listens on
    const supervisor = spawn('sleep', ['30'], { detached: true, stdio: 'ignore' });
    supervisor.unref();
    const pid = supervisor.pid as number;
    await writeRecord(record('hung1', { supervisorPid: pid, control: { port: 1, token: 't' } }), env);
    await stopInstance(ctx, 'hung1');
    expect(lines.join('')).toMatch(/^instance hung1: the supervisor did not stop it \(instance control \/stop: .+\); its processes are killed\n$/);
    await new Promise((r) => setTimeout(r, 200));
    expect(isAlive(pid)).toBe(false);
    expect(await listRecords(env)).toEqual([]);
  });
});

describe('controlCall', () => {
  let server: Server | null = null;
  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === null) resolve();
      else server.close(() => {
        resolve();
      });
    });
    server = null;
  });

  async function answering(status: number, body: string): Promise<number> {
    const made = createServer((_req, res) => {
      res.writeHead(status).end(body);
    });
    server = made;
    await new Promise<void>((resolve) => made.listen(0, '127.0.0.1', resolve));
    return (made.address() as AddressInfo).port;
  }

  it('fails an answer that is not JSON, also with status 200, instead of taking it as null', async () => {
    await expect(controlCall(await answering(200, 'not json'), 't', '/request', {}, 2000)).rejects.toThrow(/^instance control \/request failed \(200\): the answer is not JSON/);
  });

  it('takes a JSON answer, and the error of a JSON failure answer', async () => {
    expect(await controlCall(await answering(200, '{"ok":true}'), 't', '/request', {}, 2000)).toEqual({ ok: true });
    await new Promise<void>((resolve) => (server as Server).close(() => {
      resolve();
    }));
    await expect(controlCall(await answering(500, '{"error":"no client x"}'), 't', '/request', {}, 2000)).rejects.toThrow('no client x');
  });
});

describe('supervisor runner log and record events', () => {
  function supervisor(env: NodeJS.ProcessEnv, id: string, folder: string): Supervisor {
    const sup = new Supervisor(id, env);
    (sup as unknown as { folder: string }).folder = folder;
    return sup;
  }

  it('writes nothing once the instance folder is gone, and throws when the runner log cannot be written for another reason', () => {
    const base = mkdtempSync(join(tmpdir(), 'ogw-sup-'));
    expect(() => {
      supervisor(instanceEnv(), 'gone1', join(base, 'gone')).log('after stop');
    }).not.toThrow();
    writeFileSync(join(base, 'file'), '');
    expect(() => {
      supervisor(instanceEnv(), 'odd1', join(base, 'file')).log('line');
    }).toThrow(/ENOTDIR/);
  });

  it('writes a record event that cannot be recorded to the runner log, and nothing for a record a stop removed', async () => {
    const env = instanceEnv();
    const folder = await instanceFolder('evt1', env);
    mkdirSync(folder, { recursive: true });
    const recordEvent = (sup: Supervisor, what: string): void => {
      (sup as unknown as { recordEvent: (what: string, change: (r: InstanceRecord) => void) => void }).recordEvent(what, (r) => {
        r.exited.main = 1;
      });
    };
    // no record: the instance was stopped
    recordEvent(supervisor(env, 'evt1', folder), 'the exit of main');
    await new Promise((r) => setTimeout(r, 200));
    expect(existsSync(join(folder, 'runner.log'))).toBe(false);
    // a record that cannot be read
    writeFileSync(join(env.OGW_INSTANCES_DIR as string, 'evt1.json'), '{ not json');
    recordEvent(supervisor(env, 'evt1', folder), 'the exit of main');
    const deadline = Date.now() + 5000;
    while (!existsSync(join(folder, 'runner.log')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    expect(readFileSync(join(folder, 'runner.log'), 'utf8')).toMatch(/ the exit of main could not be recorded: invalid JSON in /);
  });
});

describe('supervisor social bot wait for the user of main', () => {
  it('waits while main is not connected, writes a get_state that fails to the runner log, and ends with the user id', async () => {
    const env = instanceEnv();
    const folder = await instanceFolder('soc1', env);
    mkdirSync(folder, { recursive: true });
    const sup = new Supervisor('soc1', env);
    const inner = sup as unknown as { folder: string; stopping: boolean; channels: Map<string, unknown>; mainUserId: (ms: number) => Promise<number | null> };
    inner.folder = folder;
    let asked = 0;
    const main = {
      connected: false,
      request: (): Promise<unknown> => {
        asked += 1;
        if (asked === 1) return Promise.reject(new Error('main: get_state got no response within 100 ms'));
        return Promise.resolve({ ok: true, result: { user_id: 42 }, bytes: Buffer.alloc(0), frames: [] });
      },
    };
    inner.channels.set('main', main);
    const waiting = inner.mainUserId(100);
    await new Promise((r) => setTimeout(r, 450));
    // not connected: nothing asked, nothing logged
    expect(asked).toBe(0);
    expect(existsSync(join(folder, 'runner.log'))).toBe(false);
    main.connected = true;
    expect(await waiting).toBe(42);
    expect(readFileSync(join(folder, 'runner.log'), 'utf8')).toMatch(/ social: get_state of main failed: main: get_state got no response within 100 ms\n$/);
  });
});

describe('readTable', () => {
  it('names a missing table, and fails with the read error of a table that cannot be read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-table-'));
    await expect(readTable(root, 'match_mode')).rejects.toThrow(/^data table not found: /);
    mkdirSync(join(root, 'data', 'tables', 'match_mode.csv'), { recursive: true });
    await expect(readTable(root, 'match_mode')).rejects.toMatchObject({ code: 'EISDIR' });
  });
});
