import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CommandDef } from '../../src/lib/command.ts';
import { jobWorkspace, writeJob } from '../commands/job/helpers.ts';

// Each test mocks a module the code under test imports, then imports that code anew.

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: on purpose`), { code });
}

const platform = Object.getOwnPropertyDescriptor(process, 'platform') as PropertyDescriptor;

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.doUnmock('node:fs');
  vi.doUnmock('node:child_process');
  vi.doUnmock('../../src/lib/proc.ts');
  vi.doUnmock('../../src/lib/agentctx.ts');
  vi.resetModules();
});

describe('run', () => {
  it('rejects a start that the OS refuses at once (spawn throws, as in the macOS sandbox) with a SpawnError', async () => {
    vi.resetModules();
    vi.doMock('node:child_process', async (original) => ({
      ...(await original<typeof import('node:child_process')>()),
      spawn: () => {
        throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM', errno: -1, syscall: 'spawn' });
      },
    }));
    const { run, SpawnError } = await import('../../src/lib/proc.ts');
    const failure: unknown = await run('ps', ['-o', 'ppid='], { timeoutMs: 1000 }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SpawnError);
    expect(failure).toMatchObject({ code: 'EPERM', message: 'cannot run ps: spawn EPERM' });
  });
});

describe('PID namespace and boot id', () => {
  it('reads no PID namespace without /proc on Linux, and throws another read error of it', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    for (const [code, expected] of [['ENOENT', null], ['EACCES', 'EACCES']] as const) {
      vi.resetModules();
      vi.doMock('node:fs', async (original) => ({
        ...(await original<typeof import('node:fs')>()),
        readlinkSync: () => {
          throw errno(code);
        },
      }));
      const { pidNamespace } = await import('../../src/lib/proc.ts');
      if (expected === null) expect(pidNamespace()).toBeNull();
      else expect(() => pidNamespace()).toThrow(expected);
    }
  });

  it('throws a boot id that cannot be read instead of reading it as none', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.doMock('node:child_process', async (original) => ({
      ...(await original<typeof import('node:child_process')>()),
      execFileSync: () => {
        throw errno('EPERM');
      },
    }));
    const darwin = await import('../../src/lib/proc.ts');
    expect(() => darwin.hostBootId()).toThrow('EPERM');
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.doMock('node:fs', async (original) => ({
      ...(await original<typeof import('node:fs')>()),
      readFileSync: () => {
        throw errno('EACCES');
      },
    }));
    const linux = await import('../../src/lib/proc.ts');
    expect(() => linux.hostBootId()).toThrow('EACCES');
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'freebsd' });
    expect((await import('../../src/lib/proc.ts')).hostBootId()).toBeNull();
  });
});

describe('host refresh rate', () => {
  it('reads a refresh rate that cannot be read as none, and throws an error that is not a failed read', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    for (const failure of ['failed read', 'defect'] as const) {
      vi.resetModules();
      const actual = await import('../../src/lib/proc.ts');
      // the OgwError of the fresh module graph is the one hostRefreshHz checks
      const { OgwError } = await import('../../src/lib/errors.ts');
      vi.doMock('../../src/lib/proc.ts', () => ({
        ...actual,
        runOk: () => Promise.reject(failure === 'defect' ? new TypeError('a defect') : new OgwError('system_profiler failed (1)')),
      }));
      const { hostRefreshHz } = await import('../../src/lib/display.ts');
      if (failure === 'failed read') await expect(hostRefreshHz({})).resolves.toBeNull();
      else await expect(hostRefreshHz({})).rejects.toThrow('a defect');
      vi.doUnmock('../../src/lib/proc.ts');
    }
  });

  it('reads system_profiler output that is not JSON as no rate', async () => {
    const { macosRefreshHz } = await import('../../src/lib/display.ts');
    expect(macosRefreshHz('not json')).toBeNull();
    expect(macosRefreshHz(JSON.stringify({ SPDisplaysDataType: [{ spdisplays_ndrvs: [{ _spdisplays_resolution: '1920 x 1080 @ 60.00Hz' }] }] }))).toBe(60);
  });
});

describe('agent context', () => {
  it('finds the agent by its key when ps cannot run, and throws another failure of the ancestor read', async () => {
    for (const [failure, expected] of [['spawn', 'ag1'], ['defect', 'a defect']] as const) {
      vi.resetModules();
      const actual = await import('../../src/lib/proc.ts');
      vi.doMock('../../src/lib/proc.ts', () => ({
        ...actual,
        ancestorPids: () => Promise.reject(failure === 'spawn' ? new actual.SpawnError('ps', errno('EPERM')) : new TypeError('a defect')),
      }));
      const agentctx = await import('../../src/lib/agentctx.ts');
      const ws = jobWorkspace();
      const key = agentctx.newAgentKey('ag1');
      writeJob(ws.jobs, { id: 'ag1', command: 'agent', argv: ['agent', '__run'], meta: { role: 'content', cliPid: 1234, output: '/o', runLog: '/r', keyHash: key.hash } });
      await agentctx.markAgentRunning('ag1', ws.env);
      const env = { ...ws.env, OGW_AGENT_KEY: key.value };
      if (failure === 'spawn') expect((await agentctx.agentContext(env))?.job.id).toBe(expected);
      else await expect(agentctx.agentContext(env)).rejects.toThrow(expected);
      vi.doUnmock('../../src/lib/proc.ts');
    }
  });
});

describe('runCli', () => {
  const fails: CommandDef = { name: ['fails'], usage: 'ogw fails', run: () => Promise.reject(new Error('the command failed')) };
  const reads: CommandDef = {
    name: ['reads'],
    usage: 'ogw reads',
    async run(ctx) {
      return { text: `got ${await ctx.stdin()}` };
    },
  };

  async function runWith(commands: CommandDef[], argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
    const { runCli } = await import('../../src/lib/cli.ts');
    let stdout = '';
    let stderr = '';
    const code = await runCli(commands, argv, {
      cwd: '/',
      env: { OGW_JOBS_DIR: '/nonexistent-ogw-jobs' },
      stdin: () => Promise.resolve('typed'),
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
      terminal: () => false,
    });
    return { code, stdout, stderr };
  }

  it('keeps the failure of a command as its result when its end cannot be recorded, and reports both', async () => {
    const actual = await import('../../src/lib/agentctx.ts');
    vi.doMock('../../src/lib/agentctx.ts', () => ({
      ...actual,
      agentContext: () => Promise.resolve({ job: { id: 'ag1' }, meta: { runLog: '/x' } }),
      appendRunLog: () => Promise.resolve(0),
      finishRunLog: () => Promise.reject(new Error('run log is gone')),
    }));
    const run = await runWith([fails], ['fails']);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain('the command failed');
    expect(run.stderr).toContain('cannot record the end of the command: run log is gone\n');
  });

  it('reads stdin as it is with no broker on fd 3, and fails when fd 3 cannot take the request', async () => {
    const { BROKER_RUN } = await import('../../src/lib/broker-client.ts');
    for (const [code, expected] of [['EBADF', 0], ['EPIPE', 1]] as const) {
      vi.resetModules();
      vi.doMock('node:fs', async (original) => ({
        ...(await original<typeof import('node:fs')>()),
        writeSync: (fd: number, ...rest: unknown[]) => {
          if (fd === 3) throw errno(code);
          return (fs.writeSync as (...args: unknown[]) => number)(fd, ...rest);
        },
      }));
      const fs = await vi.importActual<typeof import('node:fs')>('node:fs');
      const run = await runWith([reads], [BROKER_RUN, 'reads']);
      expect(run.code).toBe(expected);
      if (expected === 0) expect(run.stdout).toBe('got typed\n');
      else expect(run.stderr).toContain('EPIPE: on purpose');
      vi.doUnmock('node:fs');
    }
  });
});
