import { readFileSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cliToRun } from '../../../../src/commands/agent/lib/launch.ts';
import { AGENT_LOG_FOLDER, agentLogsDir } from '../../../../src/commands/agent/lib/meta.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { jobWorkspace, writeJob } from '../../job/helpers.ts';

describe.runIf(process.platform === 'darwin' || process.platform === 'linux')('play and judge sandbox: agent logs', () => {
  it('blocks the agent log folder with one rule that does not grow with the number of agent jobs', async () => {
    const ws = jobWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const paths = ws;
    const sandbox = async (): Promise<{ args: number; profile: string }> => {
      const own = join(await agentLogsDir(ws.env), 'own.cli.log');
      const { command, profileFolder } = await cliToRun(ctx, 'judge', { cli: 'claude-code', model: 'm', effort: 'high' }, paths, own);
      const profile = profileFolder === null ? '' : readFileSync(join(profileFolder, 'sandbox.sb'), 'utf8');
      if (profileFolder !== null) await rm(profileFolder, { recursive: true, force: true });
      return { args: command.args.length, profile };
    };
    const none = await sandbox();
    const ids = Array.from({ length: 40 }, (_, i) => `zqx${String(i)}`);
    for (const id of ids) {
      writeJob(ws.jobs, { id, command: 'agent', status: 'done', logFolder: AGENT_LOG_FOLDER, meta: { role: 'content' } }, { stdout: 'o', stderr: 'e' });
      writeFileSync(join(await agentLogsDir(ws.env), `${id}.cli.log`), 'brief.md says');
    }
    const many = await sandbox();
    expect(many).toEqual(none);
    for (const id of ids) expect(many.profile).not.toContain(id);
    if (process.platform === 'darwin') {
      expect(many.profile).toContain(`(subpath "${join(ws.jobs, AGENT_LOG_FOLDER)}")`);
      // the agent CLI's own output file, opened before the sandbox starts
      expect(many.profile).toContain(`(allow file-read* file-write* (literal "${join(ws.jobs, AGENT_LOG_FOLDER, 'own.cli.log')}")`);
    }
  });
});
