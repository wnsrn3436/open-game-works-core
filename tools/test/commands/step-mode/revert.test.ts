import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationRequest, botControl } from '../../../src/commands/instance/automation.ts';
import { setStepMode } from '../../../src/commands/step-mode/step-mode.ts';
import { createContext } from '../../../src/lib/command.ts';

/** The clients of the instance in its play access file; reset before each test. */
const access = vi.hoisted(() => ({ clients: ['main', 'opponent_1'] }));

vi.mock('../../../src/commands/instance/automation.ts', () => ({ automationRequest: vi.fn(), botControl: vi.fn() }));
vi.mock('../../../src/commands/instance/lib/records.ts', () => ({
  readPlayAccess: () => Promise.resolve({ clients: access.clients }),
}));

const ctx = createContext({ cwd: '/', env: {}, stdin: () => Promise.resolve(''), stderr: () => undefined });
const answer = (ok: boolean, result: unknown) => ({ ok, result, bytes: Buffer.alloc(0), frames: [], framePaths: [] });

describe('ogw step-mode revert', () => {
  let sent: string[];
  beforeEach(() => {
    sent = [];
    access.clients = ['main', 'opponent_1'];
    vi.mocked(botControl).mockReset();
    vi.mocked(botControl).mockResolvedValue();
  });

  it('reverts every client changed so far when an opponent bot client fails, and fails with that failure', async () => {
    vi.mocked(automationRequest).mockImplementation((_c, _id, command, args, client) => {
      sent.push(`${String(client)} ${command} ${args.join(' ')}`.trim());
      return Promise.resolve(client === 'opponent_1' && command === 'set_step_mode' ? answer(false, 'in match') : answer(true, null));
    });
    await expect(setStepMode(ctx, 'i1', false)).rejects.toThrow(/^opponent_1: set_step_mode failed: "in match"$/);
    expect(sent).toEqual(['main set_step_mode off', 'opponent_1 leave_match', 'opponent_1 set_step_mode off', 'main set_step_mode on']);
    expect(vi.mocked(botControl).mock.calls.map((c) => c[2])).toEqual(['pause', 'resume']);
  });

  it('adds a revert that failed to the failure: the instance is left in a mixed step mode', async () => {
    vi.mocked(automationRequest).mockImplementation((_c, _id, command, args, client) => {
      sent.push(`${String(client)} ${command} ${args.join(' ')}`.trim());
      if (client === 'opponent_1' && command === 'set_step_mode') return Promise.resolve(answer(false, 'in match'));
      if (client === 'main' && command === 'set_step_mode' && args[0] === 'on') return Promise.reject(new Error('main: automation channel closed'));
      return Promise.resolve(answer(true, null));
    });
    vi.mocked(botControl).mockImplementation((_c, _id, action) => (action === 'resume' ? Promise.reject(new Error('instance control /bots/resume timed out')) : Promise.resolve()));
    await expect(setStepMode(ctx, 'i1', false)).rejects.toThrow(
      'opponent_1: set_step_mode failed: "in match"\nstep mode was not reverted: main: set_step_mode on: main: automation channel closed; resuming the bot loops: instance control /bots/resume timed out',
    );
    // a revert answer that is not ok is a failed revert too
    vi.mocked(botControl).mockResolvedValue();
    vi.mocked(automationRequest).mockImplementation((_c, _id, command, args, client) =>
      Promise.resolve(client === 'opponent_1' && command === 'set_step_mode' ? answer(false, 'in match') : client === 'main' && args[0] === 'on' ? answer(false, 'busy') : answer(true, null)),
    );
    await expect(setStepMode(ctx, 'i1', false)).rejects.toThrow('step mode was not reverted: main: set_step_mode on: main: set_step_mode failed: "busy"');
  });

  it('reverts the later changed clients after a revert that failed, and adds each failed revert to the failure', async () => {
    access.clients = ['main', 'opponent_1', 'opponent_2'];
    vi.mocked(automationRequest).mockImplementation((_c, _id, command, args, client) => {
      sent.push(`${String(client)} ${command} ${args.join(' ')}`.trim());
      if (client === 'opponent_2' && command === 'set_step_mode') return Promise.resolve(answer(false, 'in match'));
      if (command === 'set_step_mode' && args[0] === 'off') return Promise.resolve(answer(false, `${String(client)} busy`));
      return Promise.resolve(answer(true, null));
    });
    await expect(setStepMode(ctx, 'i1', true)).rejects.toThrow(
      'opponent_2: set_step_mode failed: "in match"\nstep mode was not reverted: main: set_step_mode off: main: set_step_mode failed: "main busy"; opponent_1: set_step_mode off: opponent_1: set_step_mode failed: "opponent_1 busy"',
    );
    expect(sent.slice(-2)).toEqual(['main set_step_mode off', 'opponent_1 set_step_mode off']);
    expect(vi.mocked(botControl).mock.calls.map((c) => c[2])).toEqual(['pause', 'resume']);
  });
});
