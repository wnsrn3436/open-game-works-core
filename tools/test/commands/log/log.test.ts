import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { errorLines } from '../../../src/commands/log/log.ts';
import { ogw } from '../../helpers/workspace.ts';
import { setupRunner, startFor, stopAll, type Runner } from '../instance/runner.ts';

vi.mock('../../../src/commands/generate/api.ts', async () => (await import('../instance/mocks/apis.ts')).generate);
vi.mock('../../../src/commands/data/api.ts', async () => (await import('../instance/mocks/apis.ts')).data);
vi.mock('../../../src/commands/core/api.ts', async () => (await import('../instance/mocks/apis.ts')).core);
vi.mock('../../../src/commands/env/api.ts', async () => (await import('../instance/mocks/apis.ts')).env);
vi.mock('../../../src/commands/instance/lib/spawn.ts', () => import('../instance/mocks/spawn.ts'));
vi.mock('../../../src/commands/instance/lib/launch.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/commands/instance/lib/launch.ts')>();
  return { ...real, ...(await import('../instance/mocks/apis.ts')).launchOverrides(real) };
});

const LOG_1 = '1\tinfo\tBootstrapCore\tboot\t\n2\terror\tNetworkCore\trequest failed\tat a\\nat b\n';
const LOG_2 = '3\twarn\tUICore\tx\t\n4\terror\tshop\tno item\t\n';

describe('ogw log', () => {
  let runner: Runner;
  let id: string;

  beforeAll(async () => {
    runner = setupRunner();
    id = await startFor(runner);
  });

  afterAll(async () => {
    await stopAll(runner);
  });

  it('prints the error lines of the client log files', async () => {
    runner.config({ logs: [{ path: 'log/log_1.txt', content: LOG_1 }, { path: 'log/log_2.txt', content: LOG_2 }] });
    const run = await ogw(runner.ws, ['log', id]);
    expect(run).toMatchObject({ code: 0, stdout: '2\terror\tNetworkCore\trequest failed\tat a\\nat b\n4\terror\tshop\tno item\t\n' });
    expect(runner.requests('main').at(-1)?.command).toBe('extract_logs');
  });

  it('says so when there is no error line, and fails when extract_logs fails', async () => {
    runner.config({ logs: [{ path: 'log/log_1.txt', content: '1\tinfo\tA\tb\t\n' }] });
    expect((await ogw(runner.ws, ['log', id])).stdout).toBe('no error log\n');
    runner.config({ clients: { main: { fail: { extract_logs: 'io' } } } });
    expect((await ogw(runner.ws, ['log', id])).stderr).toContain('extract_logs failed: "io"');
  });

  it('reads only content strings', () => {
    expect(errorLines([{ path: 'a' }, null, { content: '9\terror\tx\ty\t' }])).toEqual(['9\terror\tx\ty\t']);
    expect(() => errorLines({})).toThrow('extract_logs did not return a list');
  });
});
