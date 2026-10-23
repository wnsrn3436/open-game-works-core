import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { isPlainObject } from '../../lib/json.ts';
import { LIMITS } from '../../lib/limits.ts';
import { gameSecretService } from '../../lib/secrets.ts';
import { loadGameSettings, type GameSettings } from '../../lib/settings.ts';
import { listInstances } from '../instance/api.ts';

export type AdminEnv = 'DEV' | 'STG' | 'PROD';

export type AdminTarget = { env: AdminEnv } | { instance: string };

/** Name of the admin operator of the harness tool (admin-api `## API`). */
export const OGW_OPERATOR = 'ogw';

/** A JSON body given as text (sent as is), or a binary body operation's query and raw bytes. */
export type AdminRequest = { jsonText: string } | { query: Record<string, string>; bytes: Uint8Array };

export interface AdminResponse {
  status: number;
  /** The response body as received. */
  text: string;
  /** The response body parsed as JSON. */
  body: unknown;
}

/** Data of the `OgwError` an admin operation that did not answer 200 throws. */
export interface AdminFailureData {
  operation: string;
  status: number;
  body: unknown;
}

/** Data of the `OgwError` an admin operation sent to the server throws when no HTTP answer with a JSON body came back. */
export interface AdminUnansweredData {
  operation: string;
  unanswered: true;
}

const OPERATION_NAME = /^[a-z][a-z0-9_]*$/;

interface Endpoint {
  baseUrl: string;
  secret: string;
}

/** The secret of operator `ogw` of that environment from this host's secret store, or why it cannot be read. */
export function ogwOperatorSecret(ctx: Context, game: string, settings: GameSettings, env: AdminEnv): { secret: string } | { problem: string } {
  const environment = settings.environments?.[env];
  const operators: unknown[] = isPlainObject(environment) && Array.isArray(environment.adminOperators) ? environment.adminOperators : [];
  const operator = operators.find((entry) => isPlainObject(entry) && entry.name === OGW_OPERATOR);
  const secretName = isPlainObject(operator) ? operator.secret : undefined;
  if (typeof secretName !== 'string' || secretName === '') {
    return { problem: `game settings environments.${env}.adminOperators has no operator ${OGW_OPERATOR} with a secret` };
  }
  const service = gameSecretService(game, env, secretName);
  const secret = ctx.secrets.get(service);
  if (secret === null || secret === '') return { problem: `secret ${service} is not in the secret store` };
  return { secret };
}

async function envEndpoint(ctx: Context, game: string, env: AdminEnv): Promise<Endpoint> {
  const repo = await ctx.game(game);
  const settings = await loadGameSettings(repo.root);
  const environment = settings.environments?.[env];
  const serverUrl = isPlainObject(environment) ? environment.serverUrl : undefined;
  if (typeof serverUrl !== 'string' || serverUrl === '') {
    throw new OgwError(`game settings environments.${env}.serverUrl is not set`);
  }
  const operator = ogwOperatorSecret(ctx, game, settings, env);
  if ('problem' in operator) throw new OgwError(operator.problem);
  return { baseUrl: serverUrl, secret: operator.secret };
}

async function instanceEndpoint(ctx: Context, game: string, id: string): Promise<Endpoint> {
  const instance = (await listInstances(ctx, { game })).find((entry) => entry.id === id);
  if (!instance) throw new OgwError(`instance ${id} of game ${game} is not running`);
  return { baseUrl: instance.serverUrl, secret: instance.adminSecret };
}

function operationUrl(baseUrl: string, operation: string, query: Record<string, string>): string {
  const search = new URLSearchParams(query).toString();
  return `${baseUrl.replace(/\/+$/, '')}/admin/${operation}${search === '' ? '' : `?${search}`}`;
}

function parseBody(operation: string, status: number, text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    const data: AdminUnansweredData = { operation, unanswered: true };
    throw new OgwError(`admin operation ${operation} answered HTTP ${String(status)} with a body that is not JSON`, 1, data);
  }
}

/**
 * Sends an admin operation as operator `ogw` and returns the response.
 * Any status but 200 throws a `OgwError` whose `data` is `AdminFailureData`.
 */
export async function adminSend(
  ctx: Context,
  game: string,
  target: AdminTarget,
  operation: string,
  request: AdminRequest,
): Promise<AdminResponse> {
  if (!OPERATION_NAME.test(operation)) throw new OgwError(`invalid admin operation name: ${operation}`);
  const endpoint = 'env' in target ? await envEndpoint(ctx, game, target.env) : await instanceEndpoint(ctx, game, target.instance);
  const binary = 'bytes' in request;
  const url = operationUrl(endpoint.baseUrl, operation, binary ? request.query : {});
  let response: Response;
  let text: string;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OGW_OPERATOR}.${endpoint.secret}`,
        'Content-Type': binary ? 'application/octet-stream' : 'application/json',
      },
      body: binary ? request.bytes : request.jsonText,
      signal: AbortSignal.timeout(LIMITS.httpMs),
    });
    text = await response.text();
  } catch (error) {
    const data: AdminUnansweredData = { operation, unanswered: true };
    throw new OgwError(`admin operation ${operation} to ${url} failed: ${(error as Error).message}`, 1, data);
  }
  const body = parseBody(operation, response.status, text);
  if (response.status !== 200) {
    const reason = isPlainObject(body) ? body.error : undefined;
    const data: AdminFailureData = { operation, status: response.status, body };
    throw new OgwError(
      `admin operation ${operation} failed: HTTP ${String(response.status)}${typeof reason === 'string' ? ` ${reason}` : ''}`,
      1,
      data,
    );
  }
  return { status: response.status, text, body };
}

/** Sends an admin operation as operator `ogw` and returns the response body. */
export async function adminCall(ctx: Context, game: string, target: AdminTarget, operation: string, body: unknown): Promise<unknown> {
  return (await adminSend(ctx, game, target, operation, { jsonText: JSON.stringify(body) })).body;
}

/** The HTTP status of an admin operation failure thrown by `adminSend`, or null for any other error. */
export function adminFailureStatus(error: unknown): number | null {
  if (!(error instanceof OgwError)) return null;
  const data = error.data;
  return isPlainObject(data) && typeof data.status === 'number' && typeof data.operation === 'string' ? data.status : null;
}

/**
 * Whether an error of `adminSend` came after the request was sent with no `{"error": "<reason>"}` answer:
 * no HTTP answer, a body that is not JSON, or a JSON body with no string `error`. Failures before sending are not.
 */
export function adminNoFailureAnswer(error: unknown): boolean {
  if (!(error instanceof OgwError)) return false;
  const data = error.data;
  if (isPlainObject(data) && data.unanswered === true) return true;
  if (adminFailureStatus(error) === null) return false;
  const body = (data as AdminFailureData).body;
  return !(isPlainObject(body) && typeof body.error === 'string');
}
