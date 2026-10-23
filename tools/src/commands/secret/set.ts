import type { CommandDef, Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { harnessSecretService } from '../../lib/secrets.ts';
import { tokenCheckRun } from '../env/lib/hostcheck.ts';
import { bearerValueProblem, STORE_LOGIN_TOKEN } from './lib/login-token.ts';
import { moveOldSecrets } from './lib/move.ts';
import { AGENT_LOGIN_TOKEN_SECRET } from './lib/names.ts';
import { secretTarget } from './lib/target.ts';

const USAGE = 'ogw secret set <game> <DEV|STG|PROD|signing> <name> | ogw secret set --harness <name>';

/**
 * The checks before the agent login token is stored (`tools/ogw.md` `## secret set`): an HTTP Bearer value, a play
 * or judge agent CLI that is Claude Code, and a token check run that passes. The errors name no character of the value.
 */
async function checkLoginToken(ctx: Context, value: string): Promise<void> {
  const name = AGENT_LOGIN_TOKEN_SECRET;
  const problem = bearerValueProblem(value);
  if (problem !== null) {
    throw new OgwError(
      `${name} not stored: it is not an HTTP Authorization Bearer value (one line of printable ASCII without spaces): ${problem}. Store it on one line, for example on macOS: pbpaste | tr -d '[:space:]' | tools/bin/ogw secret set --harness ${name}`,
    );
  }
  const run = await tokenCheckRun(ctx, await ctx.settings(), value);
  if (run === null) throw new OgwError(`${name} not stored: harness settings agents play and judge do not use Claude Code, so no agent uses it`);
  if (run.ok) return;
  if (run.authFailed) throw new OgwError(`${name} not stored: Claude Code in the ${run.role} agent sandbox failed to authenticate with it: ${run.output}\n${STORE_LOGIN_TOKEN}`);
  throw new OgwError(`${name} not stored: the Claude Code run with it in the ${run.role} agent sandbox failed: ${run.output}`);
}

export const set: CommandDef = {
  name: ['secret', 'set'],
  usage: USAGE,
  options: { harness: { type: 'boolean' } },
  async run(ctx, args) {
    const { service, name } = await secretTarget(ctx, args, USAGE);
    const value = (await ctx.stdin()).replace(/\r?\n$/, '');
    // An empty value counts as present everywhere a secret is checked, so it would hide the missing secret.
    if (value === '') throw new OgwError(`no value on stdin; ${name} not stored`);
    if (service === harnessSecretService(AGENT_LOGIN_TOKEN_SECRET)) await checkLoginToken(ctx, value);
    await moveOldSecrets(ctx);
    ctx.secrets.set(service, value);
    return { text: `stored ${name}`, data: { name, service } };
  },
};
