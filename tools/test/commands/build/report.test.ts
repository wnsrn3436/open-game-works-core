import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { BuildRunResult } from '../../../src/commands/build/lib/buildrun.ts';
import { artifactsBody } from '../../../src/commands/build/lib/report-sections.ts';
import { ogw, makeWorkspace, type TestWorkspace } from '../../helpers/workspace.ts';
import { commit, git, openBuildRun, setupGame, write } from './helpers.ts';

function buildRun(patch: Partial<BuildRunResult> = {}): BuildRunResult {
  return {
    env: 'DEV',
    version: '0.2.0',
    checks: [
      { name: 'adapter', result: 'pass', details: [] },
      { name: 'license', result: 'warn', details: ['resource/resources.csv: license unknown: bg/x'] },
    ],
    human: [],
    licenseWarnings: ['bg/x'],
    webSmokeLoadingMs: 1234,
    protocolChange: null,
    serverDataVersions: null,
    compatibilityBase: 'none',
    artifacts: [{ platform: 'android', path: 'builds/dev-0.2.0/android/g.apk' }],
    serverImage: { name: 'ghcr.io/example/game-server', tag: 'dev-0.2.0', digest: 'sha256:abc' },
    converters: null,
    coreSchema: null,
    matchWaitMs: null,
    ...patch,
  };
}

function jobsDir(ws: TestWorkspace): string {
  return join(ws.harness, '.git', 'ogw-jobs');
}

function fakeJob(ws: TestWorkspace, id: string, exitCode: number, stderr: string): void {
  const dir = jobsDir(ws);
  mkdirSync(dir, { recursive: true });
  const record = {
    id, argv: ['deploy', 'g', 'DEV', '0.2.0'], cwd: ws.root, command: 'deploy', game: 'g', startedAt: Date.now() + 1, endedAt: Date.now() + 2,
    status: exitCode === 0 ? 'done' : 'failed', exitCode, supervisorPid: null, pid: null, timeLimitMs: 1000, agentJob: null, summary: null, meta: {},
  };
  writeFileSync(join(dir, `${id}.json`), JSON.stringify(record));
  writeFileSync(join(dir, `${id}.stdout`), '');
  writeFileSync(join(dir, `${id}.stderr`), stderr);
}

async function devRun(ws: TestWorkspace) {
  const dir = setupGame(ws);
  write(dir, 'records/core-proposals/old.md', 'old');
  commit(dir, 'old proposal');
  const run = await openBuildRun(ws, dir, { env: 'DEV', version: '0.2.0' });
  write(dir, 'records/hardening/dev-0.2.0-server-1.md', '## changes\n\nx\n\n## unknown\n\n- first unknown\n');
  write(dir, 'records/hardening/dev-0.2.0-server-2.md', '## changes\n\nx\n\n## unknown\n\n- server unknown\n');
  write(dir, 'records/hardening/dev-0.2.0-client-1.md', '## changes\n\nx\n\n## unknown\n\nnone\n');
  write(dir, 'records/hardening/dev-0.1.0-server-1.md', 'other build');
  write(dir, `records/loops/${run.name}/check-1.json`, { commit: 'a', checks: [{ name: 'performance', platform: 'android', result: 'fail', failures: [], warnings: [] }] });
  write(dir, `records/loops/${run.name}/check-2.json`, {
    commit: 'b',
    checks: [
      { name: 'performance', platform: 'android', result: 'pass', failures: [], warnings: [] },
      { name: 'UI quality', platform: 'android', result: 'unknown', failures: [], warnings: [] },
      { name: 'static check', platform: null, result: 'pass', failures: [], warnings: [] },
    ],
  });
  write(dir, `records/loops/${run.name}/evaluate-1.json`, {});
  write(dir, `records/loops/${run.name}/evaluate-2.json`, {});
  // A fix iteration after step 4: `ogw check --loop` without `ogw loop evaluate`.
  write(dir, `records/loops/${run.name}/check-3.json`, { commit: 'c', checks: [{ name: 'performance', platform: 'android', result: 'fail', failures: [], warnings: [] }] });
  write(dir, `records/loops/${run.name}/assumptions.md`, '# assumptions\n\n## a (needs human)\n\n- decision: b\n- evidence: e\n\n## c\n\n- decision: d\n- evidence: needs human later\n');
  write(dir, 'records/core-proposals/new.md', 'new');
  commit(dir, 'run files');
  write(dir, 'builds/dev-0.2.0/build-run.json', buildRun());
  write(dir, 'builds/dev-0.2.0/privacy/google-play.md', 'x');
  return { dir, run };
}

describe('build report', () => {
  it('checks its arguments', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'done'])).stderr).toContain('no open build run');
    await openBuildRun(ws, dir);
    write(ws.root, 'reason.md', 'why');
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'stopped'])).stderr).toContain('--result stopped needs --reason');
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'done', '--reason', 'reason.md'])).stderr).toContain('takes no --reason');
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'maybe'])).stderr).toContain('invalid --result');
    expect((await ogw(ws, ['build', 'report', 'g'])).code).toBe(1);
    expect(git(dir, 'log', '--format=%s')).not.toContain('report');
  });

  it('writes and commits a DEV build report on the build branch', async () => {
    const ws = makeWorkspace();
    const { dir, run } = await devRun(ws);
    fakeJob(ws, 'job1', 1, 'failed step: 3. compose up\n');
    const out = await ogw(ws, ['build', 'report', 'g', '--result', 'done']);
    expect(out.code).toBe(0);
    const text = readFileSync(join(dir, 'records/loops', run.name, 'end.md'), 'utf8');
    expect(text).toBe(`## result

done

## protocol change

none

## compatibility base

none

## artifacts

- android: builds/dev-0.2.0/android/g.apk (none)

## server image

- name: ghcr.io/example/game-server
- image tag: dev-0.2.0
- digest: sha256:abc

## hardening

- records/hardening/dev-0.2.0-client-1.md
- records/hardening/dev-0.2.0-server-1.md
- records/hardening/dev-0.2.0-server-2.md

server round 2 unknown:
- server unknown

client round 1 unknown:
none

## checks

- adapter: pass
- license: warn
- web smoke first loading ms: 1234
- performance (android): pass (records/loops/${run.name}/check-2.json)
- UI quality (android): unknown (records/loops/${run.name}/check-2.json)

## store privacy

- builds/dev-0.2.0/privacy/google-play.md

## converters

none

## core schema

none

## deploy

- job: job1
- result: failed
- failed step: 3. compose up

## human

- license warning: bg/x
- needs human: a (decision: b)
- core proposal: records/core-proposals/new.md
`);
    expect(git(dir, 'symbolic-ref', '--short', 'HEAD')).toBe('build/dev-0.2.0');
    expect(git(dir, 'log', '-1', '--format=%s')).toBe(`build: report ${run.name}`);
    expect(git(dir, 'status', '--porcelain')).toBe('');
  });

  it('writes the stopped reason and commits on main when the tag exists', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'STG', version: '0.3.0' });
    git(dir, 'checkout', '--quiet', 'main');
    git(dir, 'tag', 'stg-0.3.0');
    git(dir, 'checkout', '--quiet', 'build/stg-0.3.0');
    write(ws.root, 'reason.md', 'stopped at 5\n');
    const out = await ogw(ws, ['build', 'report', 'g', '--result', 'stopped', '--reason', join(ws.root, 'reason.md'), '--json']);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ path: `records/loops/${run.name}/end.md`, branch: 'main' });
    const text = git(dir, 'show', `main:records/loops/${run.name}/end.md`);
    expect(text.startsWith('## result\n\nstopped\n\nstopped at 5\n\n## protocol change\n\nnone\n')).toBe(true);
    expect(text).toContain('## artifacts\n\nnone\n');
    expect(text).toContain('## deploy\n\nnone\n');
    expect(text).toContain('## human\n\nnone');
  });

  it('writes the PROD deploy, rollback and maintenance orders', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    write(dir, 'records/loops/build-prod-1.0.0/end.md', '## server image\n\n- digest: sha256:old\n');
    commit(dir, 'previous report');
    git(dir, 'tag', 'prod-1.0.0');
    const run = await openBuildRun(ws, dir, { env: 'PROD', version: '1.1.0' });
    write(dir, 'builds/prod-1.1.0/build-run.json', buildRun({
      env: 'PROD', version: '1.1.0', compatibilityBase: 'prod-1.0.0', matchWaitMs: 95000,
      protocolChange: { client_data_version: 'c', compat_client_data_version: 'p' },
      artifacts: [{ platform: 'ios', path: 'builds/prod-1.1.0/ios/g.ipa' }, { platform: 'web', path: 'builds/prod-1.1.0/web' }],
      serverImage: { name: 'ghcr.io/example/game-server', tag: 'stg-1.1.0', digest: 'sha256:new' },
      converters: [{ kind: 'Inventory', fromVersion: 3 }], coreSchema: { last: 1, current: 2 },
    }));
    write(dir, 'builds/prod-1.1.0/update/update.json', '{}');
    write(dir, 'builds/prod-1.1.0/update/items.bin', 'x');
    write(dir, 'builds/prod-1.1.0/privacy/app-store.md', 'x');
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'done'])).code).toBe(0);
    const text = readFileSync(join(dir, 'records/loops', run.name, 'end.md'), 'utf8');
    expect(text).toContain('## protocol change\n\n- client_data_version: c\n- compat_client_data_version: p\n');
    expect(text).toContain('## compatibility base\n\nprod-1.0.0\n');
    expect(text).toContain('- ios: builds/prod-1.1.0/ios/g.ipa (store review, internal testing, release)\n- web: builds/prod-1.1.0/web (none)');
    expect(text).toContain('## converters\n\n- (Inventory, 3)\n');
    expect(text).toContain('## core schema\n\n- last PROD build: 1\n- this build: 2\n\nAfter this build is deployed, the PROD server cannot be rolled back to the last PROD build.\n');
    expect(text).toContain('- builds/prod-1.1.0/privacy/app-store.md\n- account deletion URL: https://prod.example.com/account/deletion\n');
    expect(text).toContain('## deploy\n\ndeploy order\n\n1. For an app build, fills App Store Connect App Privacy');
    expect(text).toContain('   - artifacts: builds/prod-1.1.0/ios/g.ipa, builds/prod-1.1.0/web\n2. Uploads the update files with `put_update_file`\n   - update files: builds/prod-1.1.0/update/items.bin\n3. ');
    expect(text).toContain('   - match wait ms: 95000\n4. Deploys the server image');
    expect(text).toContain('   - server image: ghcr.io/example/game-server@sha256:new\n5. ');
    expect(text).not.toContain('skipped');
    expect(text).toContain('rollback order\n\n1. Posts a notice');
    expect(text).toContain('   - previous server image: - digest: sha256:old\n3. ');
    expect(text).toContain('   - update.json: builds/prod-1.1.0/update/update.json\n\nmaintenance order\n\nTurns on the kill switches as in PROD deploy 3');
    expect(text).toContain('turns off those kill switches\n   - match wait ms: 95000\n');
  });

  it('marks PROD steps that do not apply', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'PROD', version: '1.0.0-bundle-1', bundleFor: '1.0.0', data: { build: { retries: 0, bundle: 1, startCommit: 'x' } } });
    write(dir, 'builds/prod-1.0.0-bundle-1/build-run.json', buildRun({ env: 'PROD', version: '1.0.0-bundle-1', serverImage: null, coreSchema: { last: 1, current: 1 }, converters: [] }));
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'done'])).code).toBe(0);
    const text = readFileSync(join(dir, 'records/loops', run.name, 'end.md'), 'utf8');
    expect(text.match(/skipped: bundle patch without server image/g)).toHaveLength(3);
    expect(text.match(/skipped part: protocol change/g)).toHaveLength(2);
    expect(text.match(/skipped part: maintenance/g)).toHaveLength(2);
    expect(text).toContain('   - update files: none\n');
    expect(text).toContain('   - skipped: bundle patch without server image\n   - server image: none\n');
    expect(text).toContain('   - previous server image: none\n');
    expect(text).toContain('   - update.json: none\n\nmaintenance order');
  });

  it('names the server image of the most recent PROD build with a server image as the previous one', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    write(dir, 'records/loops/build-prod-1.0.0/end.md', '## server image\n\n- digest: sha256:old\n');
    commit(dir, 'prod 1.0.0');
    git(dir, 'tag', 'prod-1.0.0');
    write(dir, 'records/loops/build-prod-1.0.0-bundle-1/end.md', '## server image\n\n- digest: sha256:bundle\n');
    commit(dir, 'bundle with data');
    git(dir, 'tag', 'prod-1.0.0-bundle-1');
    write(dir, 'records/loops/build-prod-1.0.0-bundle-2/end.md', '## server image\n\nnone\n');
    commit(dir, 'bundle without data');
    git(dir, 'tag', 'prod-1.0.0-bundle-2');
    const run = await openBuildRun(ws, dir, { env: 'PROD', version: '1.1.0' });
    write(dir, 'builds/prod-1.1.0/build-run.json', buildRun({ env: 'PROD', version: '1.1.0', compatibilityBase: 'prod-1.0.0', converters: [], coreSchema: { last: 1, current: 1 } }));
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'done'])).code).toBe(0);
    const text = readFileSync(join(dir, 'records/loops', run.name, 'end.md'), 'utf8');
    expect(text).toContain('   - previous server image: - digest: sha256:bundle\n');
  });

  it('writes no rollback sentence and no maintenance on the first PROD build', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'PROD', version: '1.0.0' });
    write(dir, 'builds/prod-1.0.0/build-run.json', buildRun({ env: 'PROD', version: '1.0.0', converters: [], coreSchema: { last: null, current: 1 } }));
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'done'])).code).toBe(0);
    const text = readFileSync(join(dir, 'records/loops', run.name, 'end.md'), 'utf8');
    expect(text).toContain('## core schema\n\n- last PROD build: none\n- this build: 1\n\n## deploy');
    expect(text.match(/skipped part: maintenance/g)).toHaveLength(2);
  });

  it('writes no PROD deploy order when build run stopped before the PROD facts', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'PROD', version: '1.1.0' });
    write(ws.root, 'reason.md', 'check failed at 5\n');
    write(dir, 'builds/prod-1.1.0/build-run.json', buildRun({ env: 'PROD', version: '1.1.0', serverImage: null, converters: null, coreSchema: null }));
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'stopped', '--reason', join(ws.root, 'reason.md')])).code).toBe(0);
    const text = readFileSync(join(dir, 'records/loops', run.name, 'end.md'), 'utf8');
    expect(text).toContain('## deploy\n\nnone\n');
    expect(text).not.toContain('skipped');
  });

  it('writes the STG outlets and the failed human check targets', async () => {
    const ws = makeWorkspace();
    const dir = setupGame(ws);
    const run = await openBuildRun(ws, dir, { env: 'STG', version: '0.3.0' });
    write(dir, 'builds/stg-0.3.0/build-run.json', buildRun({
      env: 'STG', version: '0.3.0', licenseWarnings: [],
      human: [{ check: 'adapter', targets: ['environments.STG.adapters.push-apns', 'environments.STG.adapters.login-apple'] }],
      artifacts: [
        { platform: 'android', path: 'builds/stg-0.3.0/android/g.aab' },
        { platform: 'ios', path: 'builds/stg-0.3.0/ios/g.ipa' },
        { platform: 'macos', path: 'builds/stg-0.3.0/macos/g.pkg' },
        { platform: 'web', path: 'builds/stg-0.3.0/web' },
      ],
    }));
    expect((await ogw(ws, ['build', 'report', 'g', '--result', 'done'])).code).toBe(0);
    const text = readFileSync(join(dir, 'records/loops', run.name, 'end.md'), 'utf8');
    expect(text).toContain([
      '## artifacts',
      '',
      '- android: builds/stg-0.3.0/android/g.aab (Google Play open testing and closed testing)',
      '- ios: builds/stg-0.3.0/ios/g.ipa (TestFlight public link)',
      '- macos: builds/stg-0.3.0/macos/g.pkg (TestFlight public link)',
      '- web: builds/stg-0.3.0/web (none)',
      '',
    ].join('\n'));
    expect(text).toContain('## human\n\n- adapter: environments.STG.adapters.push-apns, environments.STG.adapters.login-apple\n');
  });

  it('writes the PROD outlets of android and macos', () => {
    const result = buildRun({
      env: 'PROD',
      artifacts: [{ platform: 'android', path: 'a.aab' }, { platform: 'macos', path: 'm.pkg' }, { platform: 'windows', path: 'w.zip' }],
    });
    expect(artifactsBody('PROD', result)).toBe('- android: a.aab (store review, internal testing, release)\n- macos: m.pkg (store review, internal testing, release)\n- windows: w.zip (none)');
    expect(artifactsBody('DEV', result)).toBe('- android: a.aab (none)\n- macos: m.pkg (none)\n- windows: w.zip (none)');
    const free = { ...result, artifacts: [{ platform: 'android', path: 'a.apk', freeSigning: 'debug keystore' }, { platform: 'linux', path: 'l' }] };
    expect(artifactsBody('DEV', free)).toBe('- android: a.apk (none) free signing: debug keystore\n- linux: l (none)');
  });
});
