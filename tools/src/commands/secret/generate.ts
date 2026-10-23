import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeJsonAtomic } from '../../lib/fsx.ts';
import type { GameRepo } from '../../lib/game.ts';
import { gameSecretService } from '../../lib/secrets.ts';
import { gameSettingsPath, loadGameSettings, withGameSettingsLock } from '../../lib/settings.ts';
import type { EnvName } from '../settings/lib/game-check.ts';
import { isPlainObject, type JsonObject } from '../settings/lib/json-path.ts';
import { moveOldSecrets } from './lib/move.ts';
import { environmentOf } from './lib/names.ts';
import { dbConnectionString, ed25519PublicKey, ed25519Seed, randomToken } from './lib/values.ts';

type Kind = 'ed25519' | 'random' | 'db';

/** Names of `secrets.db` and `secrets.dbPassword`. */
interface DbPair {
  db: string;
  dbPassword: string;
}

interface Generated {
  /** Settings path of the secret name, for example `secrets.turn`. */
  field: string;
  name: string;
  kind: Kind;
}

const SEED_SECRETS = ['accessTokenKey', 'updateSigningKey'];
const RANDOM_SECRETS = ['iapAccountToken', 'turn', 'dbPassword', 'devAccess'];

/** Generated secrets (`tools/ogw.md` `## secret generate`) that the environment names. */
function generatedSecrets(env: JsonObject): Generated[] {
  const secrets = isPlainObject(env.secrets) ? env.secrets : {};
  const out: Generated[] = [];
  const add = (field: string, name: unknown, kind: Kind): void => {
    if (typeof name === 'string' && !out.some((g) => g.name === name)) out.push({ field, name, kind });
  };
  for (const key of SEED_SECRETS) add(`secrets.${key}`, secrets[key], 'ed25519');
  for (const key of RANDOM_SECRETS) add(`secrets.${key}`, secrets[key], 'random');
  const operators = Array.isArray(env.adminOperators) ? env.adminOperators : [];
  operators.forEach((op, i) => {
    if (isPlainObject(op)) add(`adminOperators.${String(i)}.secret`, op.secret, 'random');
  });
  if (env.deploy !== undefined) add('secrets.db', secrets.db, 'db');
  return out;
}

function makeValue(ctx: Context, game: string, env: EnvName, secret: Generated, made: Map<string, string>, passwordName: unknown): string {
  if (secret.kind === 'ed25519') return ed25519Seed();
  if (secret.kind === 'random') return randomToken();
  if (typeof passwordName !== 'string') throw new OgwError(`environments.${env}.secrets.dbPassword is missing`);
  // dbPassword comes before db in the plan, so it is made now or already in the store.
  const password = made.get(passwordName) ?? (ctx.secrets.get(gameSecretService(game, env, passwordName)) as string);
  return dbConnectionString(password);
}

/** The `secrets.db` and `secrets.dbPassword` names of a `deploy` environment; null without `deploy` or without both names. */
function dbPair(envObject: JsonObject): DbPair | null {
  const secrets = isPlainObject(envObject.secrets) ? envObject.secrets : {};
  const { db, dbPassword } = secrets;
  if (envObject.deploy === undefined || typeof db !== 'string' || typeof dbPassword !== 'string') return null;
  return { db, dbPassword };
}

/**
 * With `deploy`, `secrets.db` must be the connection string of `secrets.dbPassword` (game settings schema
 * `secrets.dbPassword`). Returns the pair when the values after this run (made now or in the store) do not match, for
 * example a `db` already in the store with a `dbPassword` this run would make.
 */
function mismatchedDbPair(ctx: Context, game: string, env: EnvName, envObject: JsonObject, made: Map<string, string>): DbPair | null {
  const pair = dbPair(envObject);
  if (pair === null) return null;
  const value = (name: string): string | null => made.get(name) ?? ctx.secrets.get(gameSecretService(game, env, name));
  // dbPassword is made in this run when the store lacks it, so it has a value here.
  return value(pair.db) === dbConnectionString(value(pair.dbPassword) ?? '') ? null : pair;
}

/** Adds the public key of `updateSigningKey` to `updatePublicKeys`. Returns whether it was added. */
function addPublicKey(ctx: Context, game: string, env: EnvName, envObject: JsonObject, made: Map<string, string>): boolean {
  const name = isPlainObject(envObject.secrets) ? envObject.secrets.updateSigningKey : undefined;
  if (typeof name !== 'string') return false;
  // A missing updateSigningKey was made in this run, so the seed is made now or in the store.
  const seed = made.get(name) ?? (ctx.secrets.get(gameSecretService(game, env, name)) as string);
  let publicKey: string;
  try {
    publicKey = ed25519PublicKey(seed);
  } catch {
    throw new OgwError(`secret ${name} is not a standard base64 32-byte Ed25519 seed`);
  }
  const keys = Array.isArray(envObject.updatePublicKeys) ? (envObject.updatePublicKeys as unknown[]) : [];
  if (keys.includes(publicKey)) return false;
  envObject.updatePublicKeys = [...keys, publicKey];
  return true;
}

interface GenerateResult {
  generated: Generated[];
  added: boolean;
  mismatch: DbPair | null;
}

/** Makes and stores the missing generated secrets and adds the public key (`tools/ogw.md` `## secret generate`). */
async function generateSecrets(ctx: Context, repo: GameRepo, env: EnvName): Promise<GenerateResult> {
  const game = repo.name;
  const settings = await loadGameSettings(repo.root);
  const envObject = environmentOf(settings, env);
  const passwordName = isPlainObject(envObject.secrets) ? envObject.secrets.dbPassword : undefined;
  const made = new Map<string, string>();
  let generated: Generated[] = [];
  for (const secret of generatedSecrets(envObject)) {
    if (ctx.secrets.get(gameSecretService(game, env, secret.name)) !== null) continue;
    made.set(secret.name, makeValue(ctx, game, env, secret, made, passwordName));
    generated.push(secret);
  }
  const mismatch = mismatchedDbPair(ctx, game, env, envObject, made);
  if (mismatch !== null) generated = generated.filter((g) => g.name !== mismatch.db && g.name !== mismatch.dbPassword);
  const added = addPublicKey(ctx, game, env, envObject, made);
  if (generated.length > 0) await moveOldSecrets(ctx);
  for (const secret of generated) ctx.secrets.set(gameSecretService(game, env, secret.name), made.get(secret.name) as string);
  if (added) await writeJsonAtomic(gameSettingsPath(repo.root), settings);
  return { generated, added, mismatch };
}

export const generate: CommandDef = {
  name: ['secret', 'generate'],
  usage: 'ogw secret generate <game> <DEV|STG|PROD>',
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const game = positional(args, 0, 'game');
    const env = positional(args, 1, 'environment');
    if (env !== 'DEV' && env !== 'STG' && env !== 'PROD') throw new OgwError(`not DEV, STG or PROD: ${env}`);
    const repo = await ctx.game(game);
    // Reads, changes and writes game settings in the game settings lock, so no other run or command loses a change.
    const { generated, added, mismatch } = await withGameSettingsLock(repo.root, ctx.env, () => generateSecrets(ctx, repo, env));
    const lines = generated.map((s) => `generated ${s.field} ${s.name}`);
    if (added) lines.push(`added the updateSigningKey public key to environments.${env}.updatePublicKeys`);
    if (mismatch !== null) {
      lines.push(
        `secret ${mismatch.db} is not the connection string of secret ${mismatch.dbPassword}; neither is written. ` +
          `Store matching values with ogw secret set ${game} ${env} <name>, then run ogw secret generate ${game} ${env} again`,
      );
    }
    return {
      exitCode: mismatch === null ? 0 : 1,
      text: lines.length > 0 ? lines.join('\n') : 'nothing to generate',
      data: { generated: generated.map(({ field, name }) => ({ field, name })), publicKeyAdded: added, dbMismatch: mismatch },
    };
  },
};
