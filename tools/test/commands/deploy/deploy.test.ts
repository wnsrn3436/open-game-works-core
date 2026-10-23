import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { adminCall, adminSend } from '../../../src/commands/admin/api.ts';
import { commands as cloneCommands } from '../../../src/commands/clone/index.ts';
import { entryPage, POLL } from '../../../src/commands/deploy/deploy.ts';
import { putObject } from '../../../src/commands/deploy/lib/s3.ts';
import { gameModules, mergedCoreSettings } from '../../../src/commands/generate/api.ts';
import type { CommandDef } from '../../../src/lib/command.ts';
import { OgwError } from '../../../src/lib/errors.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { env as envSettings, fakeBin, gameSettings, git, setSecrets, setupGame, write } from '../build/helpers.ts';

vi.mock('../../../src/commands/admin/api.ts', async (orig) => ({ ...(await orig<object>()), adminCall: vi.fn(), adminSend: vi.fn() }));
vi.mock('../../../src/commands/generate/api.ts', async (orig) => ({ ...(await orig<object>()), gameModules: vi.fn(), mergedCoreSettings: vi.fn() }));
vi.mock('../../../src/commands/deploy/lib/s3.ts', async (orig) => ({ ...(await orig<object>()), putObject: vi.fn() }));
vi.mock('../../../src/commands/clone/index.ts', () => ({ commands: [] as CommandDef[] }));

const SSH = `prev=""
for a in "$@"; do
  case "$a" in UserKnownHostsFile=*) cp "\${a#UserKnownHostsFile=}" "$FAKE_DIR/known_hosts";; esac
  [ "$prev" = "-i" ] && cp "$a" "$FAKE_DIR/key"
  prev="$a"
done
for last; do :; done
case "$last" in
  test\\ -f*) [ -n "$FAKE_SSH_DOWN" ] && { echo "Host key verification failed." >&2; exit 255; }; [ -n "$FAKE_COMPOSE" ] && exit 0; exit 1;;
  mkdir*) cat > "$FAKE_DIR/compose.yaml";;
  *sha256sum*) [ -n "$FAKE_HASH_FAIL" ] && { echo "sha256sum: dbPassword: Permission denied" >&2; exit 1; }; [ -n "$FAKE_HASHES" ] && printf '%s\\n' "$FAKE_HASHES"; exit 0;;
  *"/secrets/."*) name=$(printf '%s' "$last" | sed -n "s|.*/secrets/\\([^'/]*\\)'$|\\1|p"); cat > "$FAKE_DIR/secret-$name";;
  *"compose up"*) [ -n "$FAKE_UP_FAIL" ] && { echo boom >&2; exit 1; }; exit 0;;
  *) exit 0;;
esac`;

/** Every secret of the DEV settings of `setup`: the ones the deploy writes as secret files, and `deploySsh`. */
const SECRETS: Record<string, string> = {
  'ogw/g/DEV/deploySsh': 'PRIVATE KEY',
  'ogw/g/DEV/cdn': 'R2SECRET',
  ...Object.fromEntries(['db', 'atk', 'usk', 'dbPassword', 'devAccess', 'adminOgw'].map((name) => [`ogw/g/DEV/${name}`, `${name}-value`])),
};

let server: Server;
let serverUrl = '';
let status = 404;

beforeEach(async () => {
  status = 404;
  server = createServer((req, res) => {
    res.statusCode = req.url === '/update/deploy_list.json' ? status : 500;
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  serverUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  POLL.intervalMs = 10;
  POLL.serverStartMs = 200;
  vi.mocked(adminCall).mockReset();
  vi.mocked(adminSend).mockReset();
  vi.mocked(adminSend).mockResolvedValue({ status: 200, text: '{}', body: {} });
  vi.mocked(putObject).mockReset();
  vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
  vi.mocked(mergedCoreSettings).mockResolvedValue({ 'game-update': { fileMaxAgeMs: 86_400_500 } });
  cloneCommands.length = 0;
});

afterEach(() => {
  server.close();
});

function adminScript(handlers: Record<string, (body: unknown) => unknown>): void {
  vi.mocked(adminCall).mockImplementation((_ctx, _game, _target, operation, body) => {
    const handler = handlers[operation];
    return handler ? Promise.resolve().then(() => handler(body)) : Promise.resolve({});
  });
}

/** Admin operations in call order: `adminCall` with its JSON body, `adminSend` with its request. */
function calls(): [string, unknown][] {
  const json = vi.mocked(adminCall).mock;
  const sent = vi.mocked(adminSend).mock;
  const all: [number, string, unknown][] = [
    ...json.calls.map((c, i): [number, string, unknown] => [json.invocationCallOrder[i] as number, c[3], c[4]]),
    ...sent.calls.map((c, i): [number, string, unknown] => [sent.invocationCallOrder[i] as number, c[3], c[4]]),
  ];
  return all.sort((a, b) => a[0] - b[0]).map(([, op, body]) => [op, body]);
}

/** The error `adminSend` throws for a non-200 answer. */
function adminError(operation: string, status: number, reason: string): OgwError {
  return new OgwError(`admin operation ${operation} failed: HTTP ${String(status)}`, 1, { operation, status, body: { error: reason } });
}

function setup(ws: TestWorkspace, opts: { web?: boolean; serverImage?: boolean; version?: string; noData?: boolean } = {}): { dir: string; fake: string; env: NodeJS.ProcessEnv } {
  const version = opts.version ?? '0.2.0';
  const settings = gameSettings();
  const environments = settings.environments as Record<string, Record<string, unknown>>;
  environments.DEV = envSettings({
    serverUrl,
    secrets: { db: 'db', accessTokenKey: 'atk', updateSigningKey: 'usk', deploySsh: 'deploySsh', dbPassword: 'dbPassword', devAccess: 'devAccess', cdn: 'cdn' },
    cdnR2: { accountId: 'acc', bucket: 'bkt', accessKeyId: 'AK', publicBaseUrl: 'https://cdn.example.com' },
  });
  const dir = setupGame(ws, 'g', { environments });
  write(dir, `builds/dev-${version}/build-run.json`, {
    env: 'DEV', version, checks: [], human: [], licenseWarnings: [], webSmokeLoadingMs: null, protocolChange: null,
    serverDataVersions: opts.noData ? null : { client_data_version: 'c', compat_client_data_version: 'compat' }, compatibilityBase: 'none', artifacts: [],
    serverImage: opts.serverImage === false || opts.noData ? null : { name: 'ghcr.io/example/game-server', tag: `dev-${version}`, digest: 'sha256:x' },
    converters: null, coreSchema: null, matchWaitMs: null,
  });
  if (!opts.noData) {
    write(dir, `builds/dev-${version}/update/items.bin`, 'items');
    write(dir, `builds/dev-${version}/update/update.json`, { data_version: 'c', data_files: [{ name: 'items.bin', size: 5, sha256: 'h' }], translation_files: [], apps: ['0.2.0'] });
  }
  if (opts.web) {
    write(dir, `builds/dev-${version}/web/index.html`, '<html>');
    write(dir, `builds/dev-${version}/web/sub/g.wasm`, 'wasm');
  }
  setSecrets(ws, SECRETS);
  const bin = fakeBin(ws, { ssh: SSH });
  return { dir, fake: bin.bin, env: { ...bin.env, FAKE_DIR: bin.bin } };
}

describe('deploy', () => {
  it('refuses PROD and a missing build', async () => {
    const ws = makeWorkspace();
    setupGame(ws);
    expect((await ogw(ws, ['deploy', 'g', 'PROD', '1.0.0'])).stderr).toContain('ogw deploy does not take PROD');
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '1.0.0'])).stderr).toContain('build dev-1.0.0 not found');
  });

  it('deploys a first DEV build: compose, update files, deploy list', async () => {
    const ws = makeWorkspace();
    const { fake, env } = setup(ws);
    adminScript({ publish_deploy_list: () => ({ sequence: 1 }) });
    const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env });
    expect(out.stderr).toBe('');
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(
      'done\n0. get_deploy_list: done\n1. docker compose down --volumes: skipped\n2. put_update_file: skipped\n3. docker compose up: done\n4. put_update_file: done\n5. start_migration_batch: skipped\n6. publish_deploy_list: done\n7. web hosting: skipped\n8. ogw clone sweep: skipped\n',
    );
    expect(calls()).toEqual([
      ['put_update_file', { query: { sha256: '5f3c4f8580d392e422e7c2f6802674ac27966c98d95c39696e4b2490168e5488' }, bytes: Buffer.from('items') }],
      ['publish_deploy_list', { app: {}, patches: { '0.2.0': { data_version: 'c', data_files: [{ name: 'items.bin', size: 5, sha256: 'h' }], translation_files: [], bundle_files: [] } } }],
    ]);
    expect(readFileSync(join(fake, 'known_hosts'), 'utf8')).toBe('deploy.example.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA\n');
    expect(readFileSync(join(fake, 'key'), 'utf8')).toBe('PRIVATE KEY\n');
    const log = readFileSync(join(fake, 'calls.log'), 'utf8');
    expect(log).toContain('-o StrictHostKeyChecking=yes');
    expect(log).toContain("deployer@deploy.example.com test -f '/srv/game/compose.yaml'");
    expect(log).toContain("cd '/srv/game' && docker compose pull");
    expect(log).toContain("cd '/srv/game' && docker compose up --detach --force-recreate\n");
    // secret files: every secret but deploySsh, value and one line break, through stdin
    for (const name of ['adminOgw', 'atk', 'cdn', 'db', 'dbPassword', 'devAccess', 'usk']) {
      expect(readFileSync(join(fake, `secret-${name}`), 'utf8')).toBe(`${SECRETS[`ogw/g/DEV/${name}`] as string}\n`);
    }
    expect(existsSync(join(fake, 'secret-deploySsh'))).toBe(false);
    expect(log).toContain("umask 077 && mkdir -p '/srv/game/secrets' && chmod 700 '/srv/game/secrets'");
    expect(log).toContain("cd '/srv/game/secrets' && chmod 600 -- 'dbPassword'");
    // a host file that exists but cannot be hashed fails the loop
    expect(log).toContain('sha256sum -- "$f" || exit 1; fi; done');
    expect(log).toContain("cd '/srv/game/secrets' && chmod 644 -- 'adminOgw' 'atk' 'cdn' 'db' 'devAccess' 'usk'");
    for (const value of Object.values(SECRETS)) expect(log).not.toContain(value);
    expect(out.stdout).not.toContain('-value');
    const compose = readFileSync(join(fake, 'compose.yaml'), 'utf8');
    expect(compose).toContain('name: "g-dev"');
    expect(compose).toContain('image: "ghcr.io/example/game-server:dev-0.2.0"');
    expect(compose).toContain('max-size: "104857600"\n        max-file: "5"');
    expect(compose).toContain('      - "adminOgw"\n      - "atk"\n      - "cdn"\n      - "db"\n      - "devAccess"\n      - "usk"\n');
    expect(compose).not.toContain('- "deploySsh"');
  });

  it('writes only the secret files whose content differs, recreates the containers only then, and keeps a PROD-tag dbPassword', async () => {
    const hash = (name: string): string => createHash('sha256').update(`${SECRETS[`ogw/g/DEV/${name}`] as string}\n`).digest('hex');
    const names = ['adminOgw', 'atk', 'cdn', 'db', 'dbPassword', 'devAccess', 'usk'];
    const ws = makeWorkspace();
    const { dir, fake, env } = setup(ws);
    adminScript({});
    const same = names.map((name) => `${hash(name)}  ${name}`).join('\n');
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_HASHES: same } })).code).toBe(0);
    expect(readdirSync(fake).filter((f) => f.startsWith('secret-'))).toEqual([]);
    let log = readFileSync(join(fake, 'calls.log'), 'utf8');
    expect(log).toContain("cd '/srv/game' && docker compose up --detach\n");
    expect(log).toContain("chmod 644 -- 'adminOgw'");

    const oneChanged = names.map((name) => `${name === 'atk' ? '0'.repeat(64) : hash(name)}  ${name}`).join('\n');
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_HASHES: oneChanged } })).code).toBe(0);
    expect(readdirSync(fake).filter((f) => f.startsWith('secret-'))).toEqual(['secret-atk']);
    log = readFileSync(join(fake, 'calls.log'), 'utf8');
    expect(log).toContain("cd '/srv/game' && docker compose up --detach --force-recreate\n");

    // with a PROD tag a different dbPassword on the host stops before any secret file is written
    git(dir, 'tag', 'prod-0.1.0');
    rmSync(join(fake, 'secret-atk'));
    const otherDb = names.map((name) => `${name === 'dbPassword' || name === 'atk' ? '0'.repeat(64) : hash(name)}  ${name}`).join('\n');
    const stopped = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_HASHES: otherDb, FAKE_COMPOSE: '1' } });
    expect(stopped.stderr).toContain("failed step: 3. docker compose up\nthe host's dbPassword differs from the secret store");
    expect(readdirSync(fake).filter((f) => f.startsWith('secret-'))).toEqual([]);
    // the same dbPassword with a PROD tag goes on and writes only the changed file
    cloneCommands.push({ name: ['clone', 'sweep'], usage: '', run: () => Promise.resolve({ text: 'swept' }) });
    adminScript({ get_migration_batch: () => ({ status: 'DONE' }) });
    const kept = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_HASHES: oneChanged, FAKE_COMPOSE: '1' } });
    expect(kept).toMatchObject({ code: 0, stderr: '' });
    expect(readdirSync(fake).filter((f) => f.startsWith('secret-'))).toEqual(['secret-atk']);
    // a host file it cannot hash stops before any file is written
    rmSync(join(fake, 'secret-atk'));
    const unread = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_HASH_FAIL: '1', FAKE_COMPOSE: '1' } });
    expect(unread.stderr).toContain('failed step: 3. docker compose up\nssh: cd \'/srv/game/secrets\'');
    expect(unread.stderr).toContain('Permission denied');
    expect(readdirSync(fake).filter((f) => f.startsWith('secret-'))).toEqual([]);
  });

  it('stops at step 3 naming every secret missing from the secret store, before it writes any', async () => {
    const ws = makeWorkspace();
    const { fake, env } = setup(ws);
    setSecrets(ws, Object.fromEntries(Object.entries(SECRETS).filter(([key]) => !key.endsWith('/db') && !key.endsWith('/usk'))));
    adminScript({});
    const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env });
    expect(out.stderr).toContain('failed step: 3. docker compose up\nsecrets of DEV not in the secret store: db, usk');
    expect(readFileSync(join(fake, 'calls.log'), 'utf8')).not.toContain('/srv/game/secrets');
  });

  it('wipes the DB of an existing deploy without PROD tag and keeps the app of the read deploy list', async () => {
    const ws = makeWorkspace();
    const { env } = setup(ws, { web: true });
    const app = { web: { min_version: '0.1.0', recommended_version: '0.2.0', store_url: 'https://x' } };
    adminScript({ get_deploy_list: () => ({ deploy_list: { app, patches: { '0.1.0': { data_version: 'compat', data_files: [], translation_files: [], bundle_files: [] } } } }) });
    const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0', '--json'], { env: { ...env, FAKE_COMPOSE: '1' } });
    expect(out.code).toBe(0);
    const steps = (JSON.parse(out.stdout) as { steps: { name: string; status: string }[] }).steps;
    expect(steps.find((s) => s.name.startsWith('1.'))?.status).toBe('done');
    expect(steps.find((s) => s.name.startsWith('7.'))?.status).toBe('done');
    const publish = calls().find(([op]) => op === 'publish_deploy_list')?.[1] as { app: unknown; patches: Record<string, unknown> };
    expect(publish.app).toEqual(app);
    expect(Object.keys(publish.patches)).toEqual(['0.2.0']);
    const puts = vi.mocked(putObject).mock.calls.map(([target, object]) => ({ target, key: object.key, type: object.contentType, cache: object.cacheControl, body: object.body.toString() }));
    expect(puts).toEqual([
      { target: { endpoint: 'https://acc.r2.cloudflarestorage.com', bucket: 'bkt', accessKeyId: 'AK', secretAccessKey: 'R2SECRET', region: 'auto' }, key: 'web/dev/0.2.0/index.html', type: 'text/html; charset=utf-8', cache: 'public, max-age=86400, immutable', body: '<html>' },
      { target: expect.anything() as unknown, key: 'web/dev/0.2.0/sub/g.wasm', type: 'application/wasm', cache: 'public, max-age=86400, immutable', body: 'wasm' },
      { target: expect.anything() as unknown, key: 'web/dev/index.html', type: 'text/html; charset=utf-8', cache: 'no-cache', body: entryPage('0.2.0') },
    ]);
    expect(entryPage('0.2.0')).toContain('location.replace("0.2.0/index.html" + location.search)');
  });

  it('with a PROD tag: uploads first, migrates, keeps the DB, and sweeps clones', async () => {
    const ws = makeWorkspace();
    const { dir, env } = setup(ws);
    git(dir, 'tag', 'prod-0.1.0');
    const sweep = vi.fn<CommandDef['run']>(() => Promise.resolve({ text: 'swept' }));
    cloneCommands.push({ name: ['clone', 'sweep'], usage: '', run: sweep });
    let polls = 0;
    adminScript({
      get_deploy_list: () => ({ app: {}, patches: { '0.1.0': { data_version: 'compat', data_files: [], translation_files: [], bundle_files: [] }, '0.0.1': { data_version: 'x', data_files: [], translation_files: [], bundle_files: [] } } }),
      get_migration_batch: () => ({ status: polls++ === 0 ? 'RUNNING' : 'DONE' }),
    });
    const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } });
    expect(out.code).toBe(0);
    expect(calls().map(([op]) => op)).toEqual(['get_deploy_list', 'put_update_file', 'start_migration_batch', 'get_migration_batch', 'get_migration_batch', 'publish_deploy_list']);
    const publish = calls().at(-1)?.[1] as { patches: Record<string, unknown> };
    expect(Object.keys(publish.patches).sort()).toEqual(['0.1.0', '0.2.0']);
    expect(sweep.mock.calls[0]?.[1]).toMatchObject({ positionals: ['g', 'DEV'] });
    expect(out.stdout).toContain('1. docker compose down --volumes: skipped\n2. put_update_file: done\n');
  });

  it('stops and names the failed step', async () => {
    const ws = makeWorkspace();
    const { env } = setup(ws);
    adminScript({});
    const up = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_UP_FAIL: '1' } });
    expect(up.code).toBe(1);
    expect(up.stderr).toContain('failed step: 3. docker compose up\nssh: cd \'/srv/game\' && docker compose up --detach --force-recreate failed (1): boom');
    expect(calls().map(([op]) => op)).not.toContain('publish_deploy_list');

    status = 503;
    const late = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env });
    expect(late.stderr).toContain('failed step: 3. docker compose up\nthe server did not answer GET /update/deploy_list.json (last status 503)');
  });

  it('stops before any step when the deploy list cannot be read', async () => {
    const ws = makeWorkspace();
    const { dir, env, fake } = setup(ws);
    const down = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_SSH_DOWN: '1' } });
    expect(down.stderr).toContain('failed step: 0. get_deploy_list\ncannot reach the deploy host: Host key verification failed.');
    vi.mocked(adminCall).mockRejectedValue(adminError('get_deploy_list', 500, 'internal'));
    const broken = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0', '--json'], { env: { ...env, FAKE_COMPOSE: '1' } });
    expect(JSON.parse(broken.stdout)).toMatchObject({ data: { failedStep: '0. get_deploy_list', steps: [] } });
    expect(existsSync(join(fake, 'compose.yaml'))).toBe(false);
    vi.mocked(adminCall).mockReset();
    vi.mocked(adminCall).mockImplementation((_c, _g, _t, op) => (op === 'get_deploy_list' ? Promise.reject(adminError('get_deploy_list', 404, 'not_found')) : Promise.resolve({})));
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } })).code).toBe(0);
    // A 404 with another reason, or a message that only names not_found, is a read failure.
    vi.mocked(adminCall).mockImplementation((_c, _g, _t, op) => (op === 'get_deploy_list' ? Promise.reject(adminError('get_deploy_list', 404, 'no_route')) : Promise.resolve({})));
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } })).stderr).toContain('failed step: 0. get_deploy_list');
    // With a PROD tag step 1 keeps the DB: a failure with no admin failure answer stops the deploy.
    git(dir, 'tag', 'prod-0.1.0');
    vi.mocked(adminCall).mockImplementation((_c, _g, _t, op) => (op === 'get_deploy_list' ? Promise.reject(new OgwError('proxy said not_found')) : Promise.resolve({})));
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } })).stderr).toContain('failed step: 0. get_deploy_list\nproxy said not_found');
  });

  it('uses the saved deploy list when the server of a deploy that step 1 wipes gives no admin failure answer', async () => {
    const app = { android: { min_version: '0.1.0', recommended_version: '0.2.0', store_url: 'https://play' } };
    const stale = { data_version: 'compat', data_files: [], translation_files: [], bundle_files: [] };
    const unanswered = { operation: 'get_deploy_list', unanswered: true };
    const unreachable = new OgwError('admin operation get_deploy_list to http://127.0.0.1:1/admin/get_deploy_list failed: fetch failed', 1, unanswered);
    const failures = [
      unreachable,
      new OgwError('admin operation get_deploy_list answered HTTP 502 with a body that is not JSON', 1, unanswered),
      new OgwError('admin operation get_deploy_list failed: HTTP 502', 1, { operation: 'get_deploy_list', status: 502, body: { message: 'bad gateway' } }),
    ];
    for (const failure of failures) {
      const ws = makeWorkspace();
      const { dir, env } = setup(ws);
      write(dir, 'builds/dev-deploy-list.json', { app, patches: { '0.1.0': stale } });
      vi.mocked(adminCall).mockReset();
      vi.mocked(adminCall).mockImplementation((_c, _g, _t, op) => (op === 'get_deploy_list' ? Promise.reject(failure) : Promise.resolve({})));
      const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } });
      expect(out).toMatchObject({ code: 0, stderr: '' });
      expect(out.stdout).toContain('0. get_deploy_list: done\n1. docker compose down --volumes: done\n');
      const publish = calls().find(([op]) => op === 'publish_deploy_list')?.[1] as { app: unknown; patches: Record<string, unknown> };
      expect(publish.app).toEqual(app);
      expect(Object.keys(publish.patches)).toEqual(['0.2.0']);
    }
    // A bundle patch without a server image keeps the running server and its DB: the same failure stops it.
    const ws = makeWorkspace();
    const { dir, env } = setup(ws, { noData: true, version: '0.2.0-bundle-1' });
    write(dir, 'builds/dev-0.2.0-bundle-1/patch/patch.json', { data_version: 'c', data_files: [], translation_files: [], bundle_files: [] });
    write(dir, 'builds/dev-deploy-list.json', { app, patches: { '0.1.0': stale } });
    vi.mocked(adminCall).mockImplementation((_c, _g, _t, op) => (op === 'get_deploy_list' ? Promise.reject(unreachable) : Promise.resolve({})));
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0-bundle-1'], { env: { ...env, FAKE_COMPOSE: '1' } })).stderr).toContain('failed step: 0. get_deploy_list\nadmin operation get_deploy_list to');
  });

  it('stops before step 1 when the deploy list read fails before it reaches the server, and goes on when the server gives no admin failure answer', async () => {
    const actual = await vi.importActual<{ adminCall: typeof adminCall }>('../../../src/commands/admin/api.ts');
    const app = { android: { min_version: '0.1.0', recommended_version: '0.2.0', store_url: 'https://play' } };
    const run = async (operatorSecret: boolean): Promise<{ out: Awaited<ReturnType<typeof ogw>>; log: string }> => {
      const ws = makeWorkspace();
      const { dir, env, fake } = setup(ws);
      write(dir, 'builds/dev-deploy-list.json', { app, patches: {} });
      if (!operatorSecret) setSecrets(ws, Object.fromEntries(Object.entries(SECRETS).filter(([key]) => key !== 'ogw/g/DEV/adminOgw')));
      vi.mocked(adminCall).mockReset();
      // The real read: the test server answers /admin/get_deploy_list with HTTP 500 and an empty body.
      vi.mocked(adminCall).mockImplementation((ctx, game, target, op, body) => (op === 'get_deploy_list' ? actual.adminCall(ctx, game, target, op, body) : Promise.resolve({})));
      const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } });
      return { out, log: readFileSync(join(fake, 'calls.log'), 'utf8') };
    };
    const local = await run(false);
    expect(local.out.stderr).toContain('failed step: 0. get_deploy_list\nsecret ogw/g/DEV/adminOgw is not in the secret store');
    expect(local.log).not.toContain('down --volumes');
    const remote = await run(true);
    expect(remote.out).toMatchObject({ code: 0, stderr: '' });
    expect(remote.out.stdout).toContain('1. docker compose down --volumes: done\n');
    expect(remote.log).toContain('down --volumes');
  });

  it('uses the app of the saved deploy list without its patches on a host without compose.yaml and on a not_found server with a PROD tag', async () => {
    const app = { android: { min_version: '0.1.0', recommended_version: '0.2.0', store_url: 'https://play' } };
    const stale = { data_version: 'compat', data_files: [], translation_files: [], bundle_files: [] };
    const published = async (prodTag: boolean): Promise<{ code: number; app: unknown; patches: string[] }> => {
      const ws = makeWorkspace();
      const { dir, env } = setup(ws);
      write(dir, 'builds/dev-deploy-list.json', { app, patches: { '0.1.0': stale } });
      vi.mocked(adminCall).mockReset();
      cloneCommands.length = 0;
      if (prodTag) {
        git(dir, 'tag', 'prod-0.1.0');
        cloneCommands.push({ name: ['clone', 'sweep'], usage: '', run: () => Promise.resolve({ text: 'swept' }) });
      }
      vi.mocked(adminCall).mockImplementation((_c, _g, _t, op) => {
        if (op === 'get_deploy_list') return Promise.reject(adminError('get_deploy_list', 404, 'not_found'));
        return Promise.resolve(op === 'get_migration_batch' ? { status: 'DONE' } : {});
      });
      const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: prodTag ? { ...env, FAKE_COMPOSE: '1' } : env });
      expect(out.stdout).toContain('1. docker compose down --volumes: skipped\n');
      const publish = calls().find(([op]) => op === 'publish_deploy_list')?.[1] as { app: unknown; patches: Record<string, unknown> };
      return { code: out.code, app: publish.app, patches: Object.keys(publish.patches) };
    };
    expect(await published(false)).toEqual({ code: 0, app, patches: ['0.2.0'] });
    expect(await published(true)).toEqual({ code: 0, app, patches: ['0.2.0'] });
  });

  it('keeps the app of the deploy list read before an earlier deploy removed the DB volume and stopped', async () => {
    const ws = makeWorkspace();
    const { dir, env } = setup(ws);
    const app = { android: { min_version: '0.1.0', recommended_version: '0.2.0', store_url: 'https://play' } };
    const stale = { data_version: 'compat', data_files: [], translation_files: [], bundle_files: [] };
    adminScript({ get_deploy_list: () => ({ deploy_list: { app, patches: { '0.1.0': stale } } }) });
    vi.mocked(adminSend).mockRejectedValue(adminError('put_update_file', 500, 'internal'));
    const first = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } });
    expect(first.stderr).toContain('failed step: 4. put_update_file');
    expect(first.stdout).toBe('');
    expect(JSON.parse(readFileSync(join(dir, 'builds', 'dev-deploy-list.json'), 'utf8'))).toEqual({ app, patches: { '0.1.0': stale } });

    // The DB volume is gone: the server answers not_found, and the saved list gives the app without its patches.
    vi.mocked(adminCall).mockReset();
    vi.mocked(adminSend).mockReset();
    vi.mocked(adminSend).mockResolvedValue({ status: 200, text: '{}', body: {} });
    vi.mocked(adminCall).mockImplementation((_c, _g, _t, op) => (op === 'get_deploy_list' ? Promise.reject(adminError('get_deploy_list', 404, 'not_found')) : Promise.resolve({})));
    const second = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } });
    expect(second.code).toBe(0);
    const publish = calls().find(([op]) => op === 'publish_deploy_list')?.[1] as { app: unknown; patches: Record<string, unknown> };
    expect(publish.app).toEqual(app);
    expect(Object.keys(publish.patches)).toEqual(['0.2.0']);
  });

  it('with a PROD tag and no compose.yaml on the host: starts the server before uploading the update files', async () => {
    const ws = makeWorkspace();
    const { dir, env } = setup(ws);
    git(dir, 'tag', 'prod-0.1.0');
    cloneCommands.push({ name: ['clone', 'sweep'], usage: '', run: () => Promise.resolve({ text: 'swept' }) });
    adminScript({ get_migration_batch: () => ({ status: 'DONE' }) });
    const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('2. put_update_file: skipped\n3. docker compose up: done\n4. put_update_file: done\n5. start_migration_batch: done\n');
    expect(calls().map(([op]) => op)).toEqual(['put_update_file', 'start_migration_batch', 'get_migration_batch', 'publish_deploy_list']);
  });

  it('stops at a failed deploy list publish, web upload or clone sweep and runs no later step', async () => {
    const run = async (fail: 'publish' | 'web' | 'sweep'): Promise<{ code: number; stderr: string; puts: number; sweeps: number }> => {
      const ws = makeWorkspace();
      const { dir, env } = setup(ws, { web: true });
      git(dir, 'tag', 'prod-0.1.0');
      const sweep = vi.fn<CommandDef['run']>(() => Promise.resolve(fail === 'sweep' ? { exitCode: 1, text: 'clone c1 failed' } : { text: 'swept' }));
      cloneCommands.length = 0;
      cloneCommands.push({ name: ['clone', 'sweep'], usage: '', run: sweep });
      vi.mocked(putObject).mockReset();
      if (fail === 'web') vi.mocked(putObject).mockRejectedValue(new Error('PUT web/dev/0.2.0/index.html answered 403'));
      adminScript({
        get_migration_batch: () => ({ status: 'DONE' }),
        publish_deploy_list: () => {
          if (fail === 'publish') throw adminError('publish_deploy_list', 409, 'conflict');
          return { sequence: 1 };
        },
      });
      const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env: { ...env, FAKE_COMPOSE: '1' } });
      return { code: out.code, stderr: out.stderr, puts: vi.mocked(putObject).mock.calls.length, sweeps: sweep.mock.calls.length };
    };
    expect(await run('publish')).toMatchObject({ code: 1, stderr: expect.stringContaining('failed step: 6. publish_deploy_list\nadmin operation publish_deploy_list failed: HTTP 409') as unknown, puts: 0, sweeps: 0 });
    expect(await run('web')).toMatchObject({ code: 1, stderr: expect.stringContaining('failed step: 7. web hosting\nPUT web/dev/0.2.0/index.html answered 403') as unknown, sweeps: 0 });
    expect(await run('sweep')).toMatchObject({ code: 1, stderr: expect.stringContaining('failed step: 8. ogw clone sweep\nogw clone sweep ended 1: clone c1 failed') as unknown, puts: 3, sweeps: 1 });
  });

  it('starts the server with --matchmaker for a realtime game', async () => {
    const ws = makeWorkspace();
    const { fake, env } = setup(ws);
    vi.mocked(gameModules).mockResolvedValue({ client: ['RealtimeCore'], server: ['matchmaker'] });
    adminScript({});
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env })).code).toBe(0);
    expect(readFileSync(join(fake, 'compose.yaml'), 'utf8')).toContain('    command: ["--env", "DEV", "--matchmaker"]');
    vi.mocked(gameModules).mockResolvedValue({ client: [], server: [] });
    expect((await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0'], { env })).code).toBe(0);
    expect(readFileSync(join(fake, 'compose.yaml'), 'utf8')).toContain('    command: ["--env", "DEV"]\n');
  });

  it('skips the server steps for a bundle patch without data and fails a failed migration', async () => {
    const ws = makeWorkspace();
    const { dir, env } = setup(ws, { noData: true, version: '0.2.0-bundle-1' });
    const patch = { data_version: 'c', data_files: [], translation_files: [], bundle_files: [{ bundle: 'patch_1', name: 'patch_1.pck', size: 1, sha256: 'p' }] };
    write(dir, 'builds/dev-0.2.0-bundle-1/patch/patch.json', patch);
    write(dir, 'builds/dev-0.2.0-bundle-1/patch/patch_1.pck', 'p');
    const kept = { data_version: 'X', data_files: [], translation_files: [], bundle_files: [] };
    adminScript({ get_deploy_list: () => ({ deploy_list: { app: {}, patches: { '0.1.0': kept, '0.2.0': { ...kept, data_version: 'Y' } } } }) });
    const out = await ogw(ws, ['deploy', 'g', 'DEV', '0.2.0-bundle-1'], { env: { ...env, FAKE_COMPOSE: '1' } });
    expect(out.code).toBe(0);
    expect(out.stdout).toContain('1. docker compose down --volumes: skipped\n2. put_update_file: skipped\n3. docker compose up: skipped\n4. put_update_file: done\n');
    // The running server stays, so the entries it accepts stay; patch.json replaces its app version.
    const publish = calls().at(-1)?.[1] as { patches: Record<string, unknown> };
    expect(publish.patches).toEqual({ '0.1.0': kept, '0.2.0': patch });

    const ws2 = makeWorkspace();
    const second = setup(ws2);
    git(second.dir, 'tag', 'prod-0.1.0');
    adminScript({ get_migration_batch: () => ({ status: 'STOPPED' }) });
    const failed = await ogw(ws2, ['deploy', 'g', 'DEV', '0.2.0'], { env: second.env });
    expect(failed.stderr).toContain('failed step: 5. start_migration_batch\nmigration batch ended STOPPED');
  });
});
