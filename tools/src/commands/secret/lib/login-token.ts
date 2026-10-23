import type { Context } from '../../../lib/command.ts';
import { harnessSecretService } from '../../../lib/secrets.ts';
import type { HarnessSettings } from '../../../lib/settings.ts';
import { agentCli } from '../../agent/lib/cli-command.ts';
import { AGENT_LOGIN_TOKEN_SECRET } from './names.ts';

/** The play and judge roles whose agent CLI is Claude Code, play first: the agents `ogw agent` gives the login token. */
export function loginTokenRoles(settings: HarnessSettings): string[] {
  return (['play', 'judge'] as const).filter((role) => {
    const agent = settings.agents[role];
    return agent !== undefined && agentCli(agent) === 'claude-code';
  });
}

/** The agent login token in the host secret store; null when it is missing or empty. */
export function storedLoginToken(ctx: Context): string | null {
  const token = ctx.secrets.get(harnessSecretService(AGENT_LOGIN_TOKEN_SECRET));
  return token === null || token === '' ? null : token;
}

/** How a human makes the agent login token and stores it on one line. */
export const STORE_LOGIN_TOKEN = `make a long-lived token with \`claude setup-token\` and store it on one line, for example on macOS: pbpaste | tr -d '[:space:]' | tools/bin/ogw secret set --harness ${AGENT_LOGIN_TOKEN_SECRET}`;

/**
 * `ogw loop start`, `ogw build start`: why they do not start, when the play or judge agent CLI is Claude Code and
 * the host secret store lacks the agent login token; null otherwise.
 */
export function missingLoginToken(ctx: Context, settings: HarnessSettings): string | null {
  const roles = loginTokenRoles(settings);
  if (roles.length === 0 || storedLoginToken(ctx) !== null) return null;
  return `harness settings agents ${roles.join(' and ')} use Claude Code and harness secret ${AGENT_LOGIN_TOKEN_SECRET} is not in this host's secret store: ${STORE_LOGIN_TOKEN}`;
}

function characterKind(code: number): string {
  if (code >= 0x80) return 'non-ASCII character';
  // space, tab, LF, VT, FF, CR
  return code === 0x20 || (code >= 0x09 && code <= 0x0d) ? 'whitespace' : 'control character';
}

/**
 * Why the value cannot be an HTTP `Authorization: Bearer` value (RFC 9110 field values have no CR, LF or control
 * characters; RFC 6750 bearer tokens have no spaces): the position (1-based, in characters) and kind of the first
 * character outside printable ASCII without space. Null when there is none. It names no character of the value.
 */
export function bearerValueProblem(value: string): string | null {
  let position = 0;
  for (const char of value) {
    position += 1;
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x21 && code <= 0x7e) continue;
    return `character ${String(position)} is a ${characterKind(code)}`;
  }
  return null;
}
