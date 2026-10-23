import { describe, expect, it } from 'vitest';
import { composeYaml } from '../../../src/commands/deploy/lib/compose.ts';
import { nextDeployList, type PatchEntry } from '../../../src/commands/deploy/lib/deploylist.ts';
import { shellQuote } from '../../../src/commands/deploy/lib/ssh.ts';

const entry = (data_version: string, bundle = ''): PatchEntry => ({
  data_version,
  data_files: [{ name: `${data_version}.bin`, size: 1, sha256: 'a' }],
  translation_files: [],
  bundle_files: bundle ? [{ bundle, name: `${bundle}.pck`, size: 1, sha256: 'b' }] : [],
});

describe('composeYaml', () => {
  it('writes the db and server services', () => {
    const yaml = composeYaml({
      game: 'g', env: 'dev', envArg: 'DEV', dir: '/srv/g', port: 8081,
      postgres: { tag: '18.6', digest: 'sha256:d' }, serverImage: 'ghcr.io/x/s:dev-1.0.0', matchmaker: true,
      dbPasswordSecret: 'dbPassword', serverSecrets: ['db', 'adminOgw', 'atk'], log: { maxBytes: 1048576, maxFiles: 3 },
    });
    expect(yaml).toBe(`name: "g-dev"
services:
  db:
    image: "postgres:18.6@sha256:d"
    environment:
      POSTGRES_PASSWORD_FILE: "/run/secrets/dbPassword"
    secrets:
      - "dbPassword"
    volumes:
      - "db-data:/var/lib/postgresql"
    healthcheck:
      test: ["CMD", "pg_isready", "-U", "postgres"]
      interval: "2s"
      timeout: "5s"
      retries: 30
    logging:
      driver: "json-file"
      options:
        max-size: "1048576"
        max-file: "3"
  server:
    image: "ghcr.io/x/s:dev-1.0.0"
    command: ["--env", "DEV", "--matchmaker"]
    ports:
      - "127.0.0.1:8081:8080"
    secrets:
      - "adminOgw"
      - "atk"
      - "db"
    depends_on:
      db:
        condition: "service_healthy"
    restart: "unless-stopped"
    logging:
      driver: "json-file"
      options:
        max-size: "1048576"
        max-file: "3"
volumes:
  db-data: {}
secrets:
  "adminOgw":
    file: "/srv/g/secrets/adminOgw"
  "atk":
    file: "/srv/g/secrets/atk"
  "db":
    file: "/srv/g/secrets/db"
  "dbPassword":
    file: "/srv/g/secrets/dbPassword"
`);
  });

  it('mounts the data folder of older majors and leaves out --matchmaker', () => {
    const yaml = composeYaml({
      game: 'g', env: 'stg', envArg: 'STG', dir: '/d', port: 9000, postgres: { tag: '17.2', digest: 'sha256:e' },
      serverImage: 'i', matchmaker: false, dbPasswordSecret: 'p', serverSecrets: [], log: { maxBytes: 2, maxFiles: 1 },
    });
    expect(yaml).toContain('"db-data:/var/lib/postgresql/data"');
    expect(yaml).toContain('command: ["--env", "STG"]');
  });
});

describe('nextDeployList', () => {
  const update = { data_version: 'new', data_files: [], translation_files: [], apps: ['1.0.0', '1.1.0', '0.9.0'] };
  const app = { android: { min_version: '1.0.0', recommended_version: '1.1.0', store_url: 'https://s' }, ios: { min_version: '1.1.0', recommended_version: '1.1.0', store_url: 'https://s' } };

  it('takes update apps at or above the lowest min_version, keeps compat entries, drops the rest', () => {
    const read = { app, patches: { '1.0.0': entry('old', 'b1'), '0.8.0': entry('compat'), '0.7.0': entry('gone') } };
    expect(nextDeployList({ read, dbWiped: false, update, patch: null, compat: 'compat' })).toEqual({
      app,
      patches: {
        '1.0.0': { data_version: 'new', data_files: [], translation_files: [], bundle_files: entry('old', 'b1').bundle_files },
        '1.1.0': { data_version: 'new', data_files: [], translation_files: [], bundle_files: [] },
        '0.8.0': entry('compat'),
      },
    });
  });

  it('takes every update app when app is empty, and counts read patches empty after a DB wipe', () => {
    const read = { app: {}, patches: { '0.8.0': entry('compat') } };
    const next = nextDeployList({ read, dbWiped: true, update, patch: null, compat: 'compat' });
    expect(Object.keys(next.patches)).toEqual(['1.0.0', '1.1.0', '0.9.0']);
    expect(next.app).toEqual({});
    expect(nextDeployList({ read: null, dbWiped: false, update: null, patch: null, compat: '' })).toEqual({ app: {}, patches: {} });
  });

  it('keeps every read entry when the server stays (no server image)', () => {
    const read = { app, patches: { '1.0.0': entry('old'), '1.1.0': entry('other'), '0.7.0': entry('older') } };
    const next = nextDeployList({ read, dbWiped: false, update: null, patch: { appVersion: '1.1.0', entry: entry('p', 'patch_1') }, compat: null });
    expect(next.patches).toEqual({ '1.0.0': entry('old'), '1.1.0': entry('p', 'patch_1'), '0.7.0': entry('older') });
  });

  it('puts patch.json over the same app version', () => {
    const next = nextDeployList({ read: { app, patches: {} }, dbWiped: false, update, patch: { appVersion: '1.0.0', entry: entry('p', 'patch_1') }, compat: '' });
    expect(next.patches['1.0.0']).toEqual(entry('p', 'patch_1'));
  });
});

describe('shellQuote', () => {
  it('quotes single quotes', () => {
    expect(shellQuote("/a b/it's")).toBe(`'/a b/it'\\''s'`);
  });
});
