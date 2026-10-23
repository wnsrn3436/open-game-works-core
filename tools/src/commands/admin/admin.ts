import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { str, type CommandArgs, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { isPlainObject } from '../../lib/json.ts';
import { adminSend, type AdminEnv, type AdminTarget } from './api.ts';

const USAGE = 'ogw admin <game> <DEV|STG|PROD> <operation> [--body <file>] | ogw admin <game> --instance <id> <operation> [--body <file>]';

/**
 * Operations `ogw admin` does not send: snapshot exports, binary body operations, and `import_guild`
 * (only `ogw clone guild` sends it).
 */
export const REFUSED_OPERATIONS: readonly string[] = [
  'export_user_snapshot',
  'export_game_state',
  'import_user_snapshot',
  'import_game_state',
  'put_update_file',
  'import_guild',
];

const ENVS: readonly string[] = ['DEV', 'STG', 'PROD'];

function targetOf(args: CommandArgs): { game: string; target: AdminTarget; operation: string } {
  const [game, second, third] = args.positionals;
  const instance = str(args, 'instance');
  if (instance !== undefined) {
    if (args.positionals.length !== 2 || game === undefined || second === undefined) throw new OgwError(`usage: ${USAGE}`);
    return { game, target: { instance }, operation: second };
  }
  if (args.positionals.length !== 3 || game === undefined || second === undefined || third === undefined) {
    throw new OgwError(`usage: ${USAGE}`);
  }
  if (!ENVS.includes(second)) throw new OgwError(`environment must be DEV, STG, or PROD: ${second}`);
  return { game, target: { env: second as AdminEnv }, operation: third };
}

async function requestBody(cwd: string, file: string | undefined): Promise<string> {
  if (file === undefined) return '{}';
  const path = resolve(cwd, file);
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    throw new OgwError(`cannot read --body file ${path}: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new OgwError(`--body file ${path} is not JSON`);
  }
  if (!isPlainObject(parsed)) {
    throw new OgwError(`--body file ${path} is not a JSON object`);
  }
  return text;
}

export const admin: CommandDef = {
  name: ['admin'],
  usage: USAGE,
  options: { instance: { type: 'string' }, body: { type: 'string' } },
  async run(ctx, args) {
    const { game, target, operation } = targetOf(args);
    if (REFUSED_OPERATIONS.includes(operation)) throw new OgwError(`ogw admin does not send ${operation}`);
    const jsonText = await requestBody(ctx.cwd, str(args, 'body'));
    const response = await adminSend(ctx, game, target, operation, { jsonText });
    return { text: response.text, data: response.body, summary: { operation, status: response.status } };
  },
};
