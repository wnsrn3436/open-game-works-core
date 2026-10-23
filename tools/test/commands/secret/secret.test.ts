import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { beforeEach, describe, expect, it } from 'vitest';
import { needles } from '../../../src/commands/build/lib/secretscan.ts';
import { secretNeedles } from '../../../src/commands/code/lib/secret.ts';
import { environmentSecrets, scopeSecretNames, signingSecrets } from '../../../src/commands/secret/lib/names.ts';
import { ed25519PublicKey } from '../../../src/commands/secret/lib/values.ts';
import { createContext } from '../../../src/lib/command.ts';
import { withGameSettingsLock } from '../../../src/lib/settings.ts';
import { ogw, makeGame, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { readGameSettingsFile, readHarnessSettingsFile, validGameSettings, type GameSettingsFixture } from '../settings/fixtures.ts';

type Settings = GameSettingsFixture;

let ws: TestWorkspace;
let file: string;

beforeEach(() => {
  const harness = readHarnessSettingsFile(join(import.meta.dirname, '..', '..', '..', '..', 'settings.json'));
  const methods = structuredClone(harness.resourceGeneration);
  methods[0].secret = 'gen-api-key';
  ws = makeWorkspace({ resourceGeneration: methods });
  const settings = validGameSettings();
  settings.signing = { android: { keystore: 'android-keystore', password: 'android-password' } };
  makeGame(ws, 'mygame', { 'settings.json': settings });
  file = join(ws.games, 'mygame', 'settings.json');
});

function store(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(join(ws.root, 'secrets.json'), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

function putStore(values: Record<string, string>): void {
  writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify(values));
}

const read = (): Settings => readGameSettingsFile(file);

describe('ogw secret set', () => {
  it('stores stdin without one trailing newline', async () => {
    const run = await ogw(ws, ['secret', 'set', 'mygame', 'DEV', 'atk-dev'], { stdin: 'value\n\n' });
    expect(run).toEqual({ code: 0, stdout: 'stored atk-dev\n', stderr: '' });
    expect(store()).toEqual({ 'ogw/mygame/DEV/atk-dev': 'value\n' });
    await ogw(ws, ['secret', 'set', 'mygame', 'DEV', 'atk-dev'], { stdin: 'other\r\n' });
    expect(store()['ogw/mygame/DEV/atk-dev']).toBe('other');
    await ogw(ws, ['secret', 'set', 'mygame', 'PROD', 'admin-ogw-prod'], { stdin: 'no newline' });
    expect(store()['ogw/mygame/PROD/admin-ogw-prod']).toBe('no newline');
  });

  it('first moves every secret that harness and game settings name out of the old store, once', async () => {
    const old = join(ws.root, 'old-secrets.json');
    writeFileSync(
      old,
      JSON.stringify({ 'ogw/mygame/STG/ssh-stg': 'ssh', 'ogw/mygame/signing/android-keystore': 'ks', 'ogw/harness/gen-api-key': 'gen', 'ogw/mygame/DEV/unnamed': 'stays' }),
    );
    makeGame(ws, 'broken', { 'settings.json': '{' });
    const env = { ...ws.env, OGW_TEST_OLD_SECRET_FILE: old };
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'DEV', 'atk-dev'], { stdin: 'v\n', env })).code).toBe(0);
    expect(store()).toEqual({
      'ogw/mygame/STG/ssh-stg': 'ssh',
      'ogw/mygame/signing/android-keystore': 'ks',
      'ogw/harness/gen-api-key': 'gen',
      'ogw/mygame/DEV/atk-dev': 'v',
    });
    expect(JSON.parse(readFileSync(old, 'utf8'))).toEqual({ 'ogw/mygame/DEV/unnamed': 'stays' });
    const moved = (JSON.parse(readFileSync(join(ws.root, 'secrets.json.moved.json'), 'utf8')) as { moved: string[] }).moved;
    expect(moved).toContain('ogw/mygame/PROD/cdn-prod');
    expect(moved).toContain('ogw/harness/gen-api-key');
  });

  it('refuses an empty value and stores nothing', async () => {
    for (const stdin of ['', '\n', '\r\n']) {
      expect(await ogw(ws, ['secret', 'set', 'mygame', 'DEV', 'atk-dev'], { stdin })).toEqual({
        code: 1,
        stdout: '',
        stderr: 'no value on stdin; atk-dev not stored\n',
      });
    }
    expect(store()).toEqual({});
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'DEV', 'atk-dev'], { stdin: '\n\n' })).code).toBe(0);
    expect(store()).toEqual({ 'ogw/mygame/DEV/atk-dev': '\n' });
  });

  it('stores signing and harness secrets', async () => {
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'signing', 'android-password'], { stdin: 'pw\n' })).code).toBe(0);
    const run = await ogw(ws, ['secret', 'set', '--harness', 'gen-api-key', '--json'], { stdin: 'key\n' });
    expect(JSON.parse(run.stdout)).toEqual({ name: 'gen-api-key', service: 'ogw/harness/gen-api-key' });
    expect(store()).toEqual({ 'ogw/mygame/signing/android-password': 'pw', 'ogw/harness/gen-api-key': 'key' });
  });

  it('stores the secret of an hf pin', async () => {
    const methods = [
      { name: 'm', kind: 'local-model', resourceTypes: ['model'], safetyTimeoutMs: 1, pins: [{ kind: 'hf', source: 'o/gated', revision: 'a'.repeat(40), files: '*', secret: 'hf-token' }] },
    ];
    const own = makeWorkspace({ resourceGeneration: methods });
    const run = await ogw(own, ['secret', 'set', '--harness', 'hf-token', '--json'], { stdin: 'hf_x\n' });
    expect(JSON.parse(run.stdout)).toEqual({ name: 'hf-token', service: 'ogw/harness/hf-token' });
    expect(JSON.parse(readFileSync(join(own.root, 'secrets.json'), 'utf8'))).toEqual({ 'ogw/harness/hf-token': 'hf_x' });
    expect((await ogw(own, ['secret', 'set', '--harness', 'other'], { stdin: 'v' })).stderr).toBe('harness settings resourceGeneration has no secret named other\n');
    const ctx = createContext({ cwd: own.root, env: own.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await secretNeedles(ctx)).toEqual([
      { label: 'workspace path', value: Buffer.from(own.root) },
      { label: 'secret hf-token', value: Buffer.from('hf_x') },
    ]);
  });

  it('gives the build secret scan the names that secret set accepts', async () => {
    const settings = read();
    const names = needles(createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined }), 'mygame', settings, 'DEV', ws.root);
    expect(names.map((n) => n.label)).toEqual(['workspace absolute path']);
    for (const name of [...scopeSecretNames(settings, 'DEV'), ...scopeSecretNames(settings, 'signing')]) {
      const scope = scopeSecretNames(settings, 'DEV').includes(name) ? 'DEV' : 'signing';
      expect((await ogw(ws, ['secret', 'set', 'mygame', scope, name], { stdin: `value-of-${name}` })).code).toBe(0);
    }
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(needles(ctx, 'mygame', settings, 'DEV', ws.root).map((n) => n.label)).toEqual([
      'workspace absolute path',
      'secret db',
      'secret accessTokenKey',
      'secret updateSigningKey',
      'secret devAccess',
      'secret deploySsh',
      'secret dbPassword',
      'admin operator ogw secret',
      'signing android keystore',
      'signing android password',
    ]);
  });

  it('refuses a name the settings do not have', async () => {
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'STG', 'atk-dev'], { stdin: 'v' })).stderr).toBe(
      'game settings environments.STG has no secret named atk-dev\n',
    );
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'signing', 'atk-dev'], { stdin: 'v' })).stderr).toBe(
      'game settings signing has no secret named atk-dev\n',
    );
    expect((await ogw(ws, ['secret', 'set', '--harness', 'atk-dev'], { stdin: 'v' })).stderr).toBe(
      'harness settings resourceGeneration has no secret named atk-dev\n',
    );
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'LOCAL', 'atk-dev'], { stdin: 'v' })).stderr).toBe('not DEV, STG, PROD or signing: LOCAL\n');
    const usage = 'usage: ogw secret set <game> <DEV|STG|PROD|signing> <name> | ogw secret set --harness <name>\n';
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'DEV'])).stderr).toBe(usage);
    expect((await ogw(ws, ['secret', 'set', '--harness'])).stderr).toBe(usage);
    expect((await ogw(ws, ['secret', 'set', '--harness', 'a', 'b'])).stderr).toBe(usage);
    expect(store()).toEqual({});
  });

  it('finds secret names in a settings environment without signing', async () => {
    const settings = read();
    delete settings.signing;
    Reflect.deleteProperty(settings.environments, 'STG');
    writeFileSync(file, JSON.stringify(settings));
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'signing', 'x'], { stdin: 'v' })).code).toBe(1);
    expect((await ogw(ws, ['secret', 'set', 'mygame', 'STG', 'x'], { stdin: 'v' })).code).toBe(1);
  });
});

describe('ogw secret generate', () => {
  it('generates the missing secrets of an environment and adds the update public key', async () => {
    const run = await ogw(ws, ['secret', 'generate', 'mygame', 'DEV']);
    expect(run.stdout.trim().split('\n')).toEqual([
      'generated secrets.accessTokenKey atk-dev',
      'generated secrets.updateSigningKey usk-dev',
      'generated secrets.dbPassword dbpw-dev',
      'generated secrets.devAccess dev-access',
      'generated adminOperators.0.secret admin-ogw-dev',
      'generated secrets.db db-dev',
      'added the updateSigningKey public key to environments.DEV.updatePublicKeys',
    ]);
    const values = store();
    const at = (name: string) => values[`ogw/mygame/DEV/${name}`] as string;
    expect(Buffer.from(at('atk-dev'), 'base64')).toHaveLength(32);
    expect(at('atk-dev')).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(at('usk-dev')).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    for (const name of ['dbpw-dev', 'dev-access', 'admin-ogw-dev']) expect(at(name)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(at('db-dev')).toBe(`postgresql://postgres:${at('dbpw-dev')}@db:5432/postgres`);
    expect(new Set([at('atk-dev'), at('usk-dev'), at('dbpw-dev'), at('dev-access'), at('admin-ogw-dev')]).size).toBe(5);
    expect(read().environments.DEV.updatePublicKeys).toEqual([ed25519PublicKey(at('usk-dev'))]);
    expect(run.stdout).not.toContain(at('atk-dev'));
    const again = await ogw(ws, ['secret', 'generate', 'mygame', 'DEV', '--json']);
    expect(JSON.parse(again.stdout)).toEqual({ generated: [], publicKeyAdded: false, dbMismatch: null });
    expect(store()).toEqual(values);
  });

  it('generates only secrets the environment names and the store lacks', async () => {
    const settings = read();
    settings.environments.PROD.secrets.iapAccountToken = 'iap-token';
    settings.environments.PROD.secrets.turn = 'turn-secret';
    settings.environments.PROD.updatePublicKeys = ['AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='];
    writeFileSync(file, JSON.stringify(settings, null, 2));
    putStore({ 'ogw/mygame/PROD/atk-prod': 'kept' });
    const run = await ogw(ws, ['secret', 'generate', 'mygame', 'PROD']);
    expect(run.stdout.trim().split('\n')).toEqual([
      'generated secrets.updateSigningKey usk-prod',
      'generated secrets.iapAccountToken iap-token',
      'generated secrets.turn turn-secret',
      'generated adminOperators.0.secret admin-ogw-prod',
      'added the updateSigningKey public key to environments.PROD.updatePublicKeys',
    ]);
    expect(store()['ogw/mygame/PROD/atk-prod']).toBe('kept');
    expect(store()['ogw/mygame/PROD/db-prod']).toBeUndefined();
    expect(read().environments.PROD.updatePublicKeys).toEqual([
      'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      ed25519PublicKey(store()['ogw/mygame/PROD/usk-prod'] as string),
    ]);
  });

  it('builds the connection string from a stored database password', async () => {
    const seed = Buffer.alloc(32, 7).toString('base64');
    putStore({
      'ogw/mygame/STG/dbpw-stg': 'stored-pw',
      'ogw/mygame/STG/usk-stg': seed,
      'ogw/mygame/STG/atk-stg': 'x',
      'ogw/mygame/STG/admin-ogw-stg': 'x',
    });
    const run = await ogw(ws, ['secret', 'generate', 'mygame', 'STG']);
    expect(run.stdout).toBe(
      'generated secrets.db db-stg\nadded the updateSigningKey public key to environments.STG.updatePublicKeys\n',
    );
    expect(store()['ogw/mygame/STG/db-stg']).toBe('postgresql://postgres:stored-pw@db:5432/postgres');
    expect(read().environments.STG.updatePublicKeys).toEqual([ed25519PublicKey(seed)]);
  });

  it('fails on a stored update signing key that is not a seed', async () => {
    putStore({ 'ogw/mygame/STG/usk-stg': 'short' });
    const before = readFileSync(file, 'utf8');
    const run = await ogw(ws, ['secret', 'generate', 'mygame', 'STG']);
    expect(run).toEqual({ code: 1, stdout: '', stderr: 'secret usk-stg is not a standard base64 32-byte Ed25519 seed\n' });
    expect(Object.keys(store())).toEqual(['ogw/mygame/STG/usk-stg']);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('fails when a deploy environment has no database password', async () => {
    const settings = read();
    delete settings.environments.DEV.secrets.dbPassword;
    delete settings.environments.DEV.secrets.updateSigningKey;
    writeFileSync(file, JSON.stringify(settings));
    expect((await ogw(ws, ['secret', 'generate', 'mygame', 'DEV'])).stderr).toBe('environments.DEV.secrets.dbPassword is missing\n');
    settings.environments.DEV.secrets.dbPassword = 'dbpw-dev';
    writeFileSync(file, JSON.stringify(settings));
    putStore({ 'ogw/mygame/DEV/dbpw-dev': 'x' });
    const run = await ogw(ws, ['secret', 'generate', 'mygame', 'DEV']);
    expect(run.stdout).not.toContain('updatePublicKeys');
    expect(store()['ogw/mygame/DEV/db-dev']).toBe('postgresql://postgres:x@db:5432/postgres');
  });

  it('makes the other secrets and fails without writing db and the database password when a stored db would not match', async () => {
    const old = 'postgresql://postgres:old@db:5432/postgres';
    const mismatch =
      'secret db-dev is not the connection string of secret dbpw-dev; neither is written. ' +
      'Store matching values with ogw secret set mygame DEV <name>, then run ogw secret generate mygame DEV again';
    putStore({ 'ogw/mygame/DEV/db-dev': old });
    const run = await ogw(ws, ['secret', 'generate', 'mygame', 'DEV']);
    expect(run.code).toBe(1);
    const lines = run.stdout.trim().split('\n');
    expect(lines.slice(-2)).toEqual(['added the updateSigningKey public key to environments.DEV.updatePublicKeys', mismatch]);
    expect(lines.filter((l) => l.startsWith('generated ')).map((l) => l.split(' ')[2])).toEqual(['atk-dev', 'usk-dev', 'dev-access', 'admin-ogw-dev']);
    expect(Object.keys(store()).sort()).toEqual([
      'ogw/mygame/DEV/admin-ogw-dev',
      'ogw/mygame/DEV/atk-dev',
      'ogw/mygame/DEV/db-dev',
      'ogw/mygame/DEV/dev-access',
      'ogw/mygame/DEV/usk-dev',
    ]);
    expect(store()['ogw/mygame/DEV/db-dev']).toBe(old);
    expect(read().environments.DEV.updatePublicKeys).toEqual([ed25519PublicKey(store()['ogw/mygame/DEV/usk-dev'] as string)]);
    const json = await ogw(ws, ['secret', 'generate', 'mygame', 'DEV', '--json']);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout)).toEqual({ generated: [], publicKeyAdded: false, dbMismatch: { db: 'db-dev', dbPassword: 'dbpw-dev' } });

    putStore({ ...store(), 'ogw/mygame/DEV/dbpw-dev': 'new' });
    expect(await ogw(ws, ['secret', 'generate', 'mygame', 'DEV'])).toEqual({ code: 1, stdout: `${mismatch}\n`, stderr: '' });
    expect(store()['ogw/mygame/DEV/db-dev']).toBe(old);
    putStore({ ...store(), 'ogw/mygame/DEV/dbpw-dev': 'old' });
    expect(await ogw(ws, ['secret', 'generate', 'mygame', 'DEV'])).toEqual({ code: 0, stdout: 'nothing to generate\n', stderr: '' });
    expect(store()['ogw/mygame/DEV/db-dev']).toBe(old);
  });

  it('moves every secret that harness and game settings name out of the old store before it writes one, and not when it writes none', async () => {
    expect((await ogw(ws, ['secret', 'generate', 'mygame', 'DEV'])).code).toBe(0);
    const old = join(ws.root, 'old-secrets.json');
    const oldValues = { 'ogw/mygame/STG/ssh-stg': 'ssh', 'ogw/mygame/signing/android-keystore': 'ks', 'ogw/harness/gen-api-key': 'gen', 'ogw/mygame/DEV/unnamed': 'stays' };
    writeFileSync(old, JSON.stringify(oldValues));
    const marker = join(ws.root, 'secrets.json.moved.json');
    const env = { ...ws.env, OGW_TEST_OLD_SECRET_FILE: old };
    expect(await ogw(ws, ['secret', 'generate', 'mygame', 'DEV'], { env })).toEqual({ code: 0, stdout: 'nothing to generate\n', stderr: '' });
    expect(JSON.parse(readFileSync(old, 'utf8'))).toEqual(oldValues);
    expect(existsSync(marker)).toBe(false);
    expect((await ogw(ws, ['secret', 'generate', 'mygame', 'STG'], { env })).code).toBe(0);
    expect(JSON.parse(readFileSync(old, 'utf8'))).toEqual({ 'ogw/mygame/DEV/unnamed': 'stays' });
    expect(store()).toMatchObject({ 'ogw/mygame/STG/ssh-stg': 'ssh', 'ogw/mygame/signing/android-keystore': 'ks', 'ogw/harness/gen-api-key': 'gen' });
    const moved = (JSON.parse(readFileSync(marker, 'utf8')) as { moved: string[] }).moved;
    expect(moved).toEqual(expect.arrayContaining(['ogw/mygame/STG/ssh-stg', 'ogw/mygame/signing/android-keystore', 'ogw/harness/gen-api-key']));
  });

  it('reads and writes game settings in the game settings lock, so a change made by another command keeps', async () => {
    const held = await withGameSettingsLock(join(ws.games, 'mygame'), ws.env, async () => {
      // another holder of the lock reads, changes and writes the file while generate runs
      const settings = read();
      const running = ogw(ws, ['secret', 'generate', 'mygame', 'DEV']);
      await sleep(500);
      settings.nicknameUnique = false;
      writeFileSync(file, JSON.stringify(settings, null, 2));
      return { running };
    });
    expect((await held.running).code).toBe(0);
    const settings = read();
    expect(settings.nicknameUnique).toBe(false);
    expect(settings.environments.DEV.updatePublicKeys).toEqual([ed25519PublicKey(store()['ogw/mygame/DEV/usk-dev'] as string)]);
  });

  it('keeps the public keys of runs for other environments that run at the same time', async () => {
    const runs = await Promise.all(['DEV', 'STG', 'PROD'].map((env) => ogw(ws, ['secret', 'generate', 'mygame', env])));
    expect(runs.map((r) => r.code)).toEqual([0, 0, 0]);
    const settings = read();
    for (const [env, name] of [['DEV', 'usk-dev'], ['STG', 'usk-stg'], ['PROD', 'usk-prod']] as const) {
      const seed = store()[`ogw/mygame/${env}/${name}`] as string;
      expect(settings.environments[env].updatePublicKeys).toEqual([ed25519PublicKey(seed)]);
    }
  });

  it('does not match db and the database password without deploy or without both names', async () => {
    const settings = read();
    settings.environments.PROD.secrets.dbPassword = 'dbpw-prod';
    delete settings.environments.STG.secrets.dbPassword;
    settings.environments.STG.secrets.devAccess = 'dev-access-stg';
    delete settings.environments.DEV.secrets.db;
    writeFileSync(file, JSON.stringify(settings));
    putStore({ 'ogw/mygame/PROD/db-prod': 'custom', 'ogw/mygame/STG/db-stg': 'custom' });
    const prod = await ogw(ws, ['secret', 'generate', 'mygame', 'PROD', '--json']);
    expect((JSON.parse(prod.stdout) as { generated: { name: string }[] }).generated.map((g) => g.name)).toContain('dbpw-prod');
    expect(store()['ogw/mygame/PROD/db-prod']).toBe('custom');
    expect((await ogw(ws, ['secret', 'generate', 'mygame', 'STG'])).code).toBe(0);
    expect(store()['ogw/mygame/STG/db-stg']).toBe('custom');
    const dev = await ogw(ws, ['secret', 'generate', 'mygame', 'DEV', '--json']);
    expect((JSON.parse(dev.stdout) as { generated: { name: string }[] }).generated.map((g) => g.name)).toEqual([
      'atk-dev',
      'usk-dev',
      'dbpw-dev',
      'dev-access',
      'admin-ogw-dev',
    ]);
  });

  it('generates a name used by two fields once', async () => {
    const settings = read();
    settings.environments.DEV.secrets.dbPassword = 'shared';
    settings.environments.DEV.secrets.devAccess = 'shared';
    writeFileSync(file, JSON.stringify(settings));
    const run = await ogw(ws, ['secret', 'generate', 'mygame', 'DEV', '--json']);
    const data = JSON.parse(run.stdout) as { generated: { field: string; name: string }[] };
    expect(data.generated.map((g) => g.name)).toEqual(['atk-dev', 'usk-dev', 'shared', 'admin-ogw-dev', 'db-dev']);
  });

  it('checks the arguments', async () => {
    expect((await ogw(ws, ['secret', 'generate', 'mygame', 'signing'])).stderr).toBe('not DEV, STG or PROD: signing\n');
    expect((await ogw(ws, ['secret', 'generate', 'mygame'])).stderr).toBe('usage: ogw secret generate <game> <DEV|STG|PROD>\n');
    const settings = read();
    Reflect.deleteProperty(settings.environments, 'STG');
    writeFileSync(file, JSON.stringify(settings));
    expect((await ogw(ws, ['secret', 'generate', 'mygame', 'STG'])).stderr).toBe('game settings have no environments.STG\n');
  });
});

describe('secret names', () => {
  it('reads string names only, with labels', () => {
    const env = { secrets: { db: 'db-x', bad: 3 }, adminOperators: [null, 'x', { name: 'a' }, { name: 'b', secret: 'b-s' }, { secret: 'n-s' }] };
    expect(environmentSecrets(env)).toEqual([
      { label: 'secret db', name: 'db-x' },
      { label: 'admin operator b secret', name: 'b-s' },
      { label: 'admin operator undefined secret', name: 'n-s' },
    ]);
    expect(environmentSecrets({ secrets: 'x', adminOperators: {} })).toEqual([]);
    const settings = { signing: { android: { keystore: 'ks', alias: 7 }, ios: 'x' } } as never;
    expect(signingSecrets(settings)).toEqual([{ label: 'signing android keystore', name: 'ks' }]);
    expect(signingSecrets({ signing: ['x'] })).toEqual([]);
    expect(scopeSecretNames(settings, 'signing')).toEqual(['ks']);
    expect(scopeSecretNames({ environments: { DEV: env } }, 'DEV')).toEqual(['db-x', 'b-s', 'n-s']);
    expect(scopeSecretNames({ environments: { DEV: 'x' } } as never, 'DEV')).toEqual([]);
    expect(scopeSecretNames({}, 'STG')).toEqual([]);
  });
});

describe('ed25519PublicKey', () => {
  it('gives the RFC 8032 test vector', () => {
    const seed = Buffer.from('9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60', 'hex').toString('base64');
    const expected = Buffer.from('d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a', 'hex').toString('base64');
    expect(ed25519PublicKey(seed)).toBe(expected);
    expect(() => ed25519PublicKey(Buffer.alloc(31).toString('base64'))).toThrow('not a standard base64 32-byte Ed25519 seed');
    expect(() => ed25519PublicKey(`${seed}\n`)).toThrow('not a standard base64 32-byte Ed25519 seed');
  });
});
