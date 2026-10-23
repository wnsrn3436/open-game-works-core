import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../../../src/lib/proc.ts';
import { requestTimeoutMs } from '../../../../src/commands/instance/automation.ts';
import {
  BotGate,
  assignJoins,
  commandNames,
  inputOf,
  oneCommand,
  roomCapable,
  roomJoinCount,
  roomWatch,
  rowOfMode,
  type OpponentBot,
} from '../../../../src/commands/instance/lib/bots.ts';
import { boolCell, intCell, readTable } from '../../../../src/commands/instance/lib/csv.ts';
import { dataRows, dataTable, parseCsv, parseCsvRecords } from '../../../../src/lib/datatable.ts';
import * as buildCsv from '../../../../src/commands/build/lib/csv.ts';
import * as staticCsv from '../../../../src/commands/check/static/lib/csv.ts';
import {
  clientLaunch,
  launchValueFileContent,
  newLocalSecrets,
  populateLaunch,
  renderingMethod,
  serverDataFolder,
  serverLaunch,
  serverSecretValues,
  serverStartArgs,
  writeSecretFile,
} from '../../../../src/commands/instance/lib/launch.ts';
import { concurrencyLimit, instancePlatform, opponentRows } from '../../../../src/commands/instance/lib/prepare.ts';
import { INPUT_COMMANDS, STEP_COMMANDS, inputHelp, inputHoldMs, isInputCommand, isRefusedByCommand, playAccessRefusal } from '../../../../src/commands/instance/lib/qa.ts';
import { parseQaBuiltins } from '../../../../src/commands/check/static/lib/specs.ts';
import { checkInstanceId } from '../../../../src/commands/instance/lib/records.ts';
import { evalCondition, parseFixture, runStep, waitBootDone, waitCondition, type Requester } from '../../../../src/commands/instance/lib/steps.ts';
import type { HarnessSettings } from '../../../../src/lib/settings.ts';

const ok = (result: unknown) => Promise.resolve({ ok: true, result, bytes: Buffer.alloc(0), frames: [] });

describe('conditions', () => {
  const state = { boot_stage: 'Done', tutorial: { id: '[t1]' }, completed_tutorials: { '[t1]': true }, coins: 5 };
  const telemetry = { goal_intervals: [{}, {}] };
  it('reads state and telemetry paths with every op', () => {
    expect(evalCondition({ path: 'state.boot_stage', op: 'eq', value: 'Done' }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'state.tutorial.id', op: 'eq', value: '[t1]' }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'state.tutorial', op: 'eq', value: { id: '[t1]' } }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'state.tutorial', op: 'eq', value: { id: '[t2]' } }, state, telemetry)).toBe(false);
    expect(evalCondition({ path: 'state.completed_tutorials.[t1]', op: 'eq', value: true }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'state.boot_stage', op: 'ne', value: 'Login' }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'state.coins', op: 'gte', value: 5 }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'state.coins', op: 'gte', value: 6 }, state, telemetry)).toBe(false);
    expect(evalCondition({ path: 'state.coins', op: 'lte', value: 5 }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'state.coins', op: 'lte', value: 4 }, state, telemetry)).toBe(false);
    expect(evalCondition({ path: 'state.boot_stage', op: 'gte', value: 1 }, state, telemetry)).toBe(false);
    expect(evalCondition({ path: 'telemetry.goal_intervals', op: 'count_gte', value: 2 }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'telemetry.goal_intervals', op: 'count_gte', value: 3 }, state, telemetry)).toBe(false);
    expect(evalCondition({ path: 'state.missing', op: 'ne', value: 1 }, state, telemetry)).toBe(false);
    expect(evalCondition({ all: [{ path: 'state.coins', op: 'eq', value: 5 }, { path: 'state.coins', op: 'eq', value: 6 }] }, state, telemetry)).toBe(false);
    expect(evalCondition({ all: [{ path: 'state.coins', op: 'eq', value: 5 }] }, state, telemetry)).toBe(true);
    expect(evalCondition({ path: 'state.tutorial', op: 'eq', value: [1] }, { tutorial: [1] }, null)).toBe(true);
    expect(evalCondition({ path: 'state.tutorial', op: 'eq', value: [1, 2] }, { tutorial: [1] }, null)).toBe(false);
    expect(evalCondition({ path: 'state.x', op: 'eq', value: { a: 1 } }, { x: { a: 1, b: 2 } }, null)).toBe(false);
  });
  it('rejects malformed conditions', () => {
    expect(() => evalCondition(null, state, telemetry)).toThrow('invalid condition');
    expect(() => evalCondition({ op: 'eq' }, state, telemetry)).toThrow('invalid condition: no path');
    expect(() => evalCondition({ path: 'other.x', op: 'eq' }, state, telemetry)).toThrow('invalid condition path: other.x');
    expect(() => evalCondition({ path: 'state.coins', op: 'gt', value: 1 }, state, telemetry)).toThrow('invalid condition op: gt');
  });
});

describe('steps', () => {
  it('parses save fixtures and rejects bad steps', () => {
    expect(parseFixture('{"steps":[{"kind":"setup","command":"restart","timeoutMs":5}]}')).toEqual([
      { kind: 'setup', command: 'restart', args: [], until: null, timeoutMs: 5 },
    ]);
    expect(() => parseFixture('nope')).toThrow('invalid save fixture: not JSON');
    expect(() => parseFixture('{}')).toThrow('invalid save fixture: no steps');
    expect(() => parseFixture('{"steps":[1]}')).toThrow('step 1 is not an object');
    expect(() => parseFixture('{"steps":[{"kind":"setup","timeoutMs":1}]}')).toThrow('step 1 has no command');
    expect(() => parseFixture('{"steps":[{"kind":"setup","command":"a","args":[1],"timeoutMs":1}]}')).toThrow('args is not a list of strings');
    expect(() => parseFixture('{"steps":[{"kind":"setup","command":"a","timeoutMs":0}]}')).toThrow('timeoutMs is not an integer of 1 or more');
    expect(() => parseFixture('{"steps":[{"kind":"setup","command":"a","timeoutMs":1.5}]}')).toThrow('timeoutMs');
  });

  it('waits for Done, fails on Halted and on time', async () => {
    const stages = ['Login', 'Done'];
    const request: Requester = () => ok({ boot_stage: stages.shift() });
    expect(await waitBootDone(request, 2000, 1000)).toEqual({ boot_stage: 'Done' });
    await expect(waitBootDone(() => ok({ boot_stage: 'Halted' }), 2000, 1000)).rejects.toThrow('boot_stage is Halted');
    await expect(waitBootDone(() => ok({ boot_stage: 'Login' }), 300, 1000)).rejects.toThrow('boot_stage did not reach Done within 300 ms');
    await expect(waitBootDone(() => Promise.resolve({ ok: false, result: 'x', bytes: Buffer.alloc(0), frames: [] }), 300, 100)).rejects.toThrow(
      'get_state failed: "x"',
    );
  });

  it('waits for conditions with telemetry and runs steps', async () => {
    const calls: string[] = [];
    let n = 0;
    const request: Requester = (command) => {
      calls.push(command);
      if (command === 'get_telemetry') return ok({ goal_intervals: Array.from({ length: n++ }) });
      return ok({ boot_stage: 'Done' });
    };
    await waitCondition(request, { path: 'telemetry.goal_intervals', op: 'count_gte', value: 2 }, 3000);
    expect(calls.filter((c) => c === 'get_telemetry')).toHaveLength(3);
    await expect(waitCondition(request, { path: 'state.boot_stage', op: 'eq', value: 'X' }, 250)).rejects.toThrow('condition not reached within 250 ms');
    await runStep(request, { kind: 'setup', command: 'go', args: [], until: null, timeoutMs: 100 }, 0);
    await expect(
      runStep(() => Promise.reject(new Error('gone')), { kind: 'setup', command: 'go', args: [], until: null, timeoutMs: 100 }, 2),
    ).rejects.toThrow('step 3 (go) failed: gone');
    await expect(
      runStep(request, { kind: 'setup', command: 'go', args: [], until: { path: 'state.boot_stage', op: 'eq', value: 'X' }, timeoutMs: 250 }, 0),
    ).rejects.toThrow('step 1 (go) failed: condition not reached');
  });
});

describe('csv', () => {
  it('parses RFC 4180 with quotes, CRLF and BOM', () => {
    expect(parseCsv('﻿a,"b,c","d""e"\r\nf,,\n')).toEqual([
      ['a', 'b,c', 'd"e'],
      ['f', '', ''],
    ]);
    expect(parseCsv('x,y')).toEqual([['x', 'y']]);
    expect(parseCsv('x\n"multi\nline",z\n')).toEqual([['x'], ['multi\nline', 'z']]);
  });

  it('is the one data table reader the build and ogw check static also use', () => {
    expect(buildCsv.parseCsv).toBe(parseCsv);
    expect(buildCsv.dataRows).toBe(dataRows);
    expect(staticCsv.parseCsv).toBe(parseCsvRecords);
    // The same rows for the same table: header rows, empty rows, `,` rows and `#` id rows are left out, also when
    // `id` is not the first column.
    const text = 'd,d,d\nAll,All,All\nstring,id(key),int\n#note,id,n\nx,[a],1\n,,\n\n[y],#[b],2\n#z,[c],3\n';
    const fromStatic = staticCsv.parseDataTable('data/tables/t.csv', text);
    expect(fromStatic?.rows.map((r) => r.cells[1])).toEqual(['[a]', '[c]']);
    expect(dataTable(text)?.rows.map((r) => r.id)).toEqual(['[a]', '[c]']);
  });

  it('reads a data table without header rows and # rows, and reads cells', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-csv-'));
    mkdirSync(join(root, 'data', 'tables'), { recursive: true });
    writeFileSync(join(root, 'data', 'tables', 't.csv'), 'd,d\nAll,All\nid(key),int?\nid,n\n[a],3\n#[b],4\n\n,\n[c],null\n[d],x\n');
    const table = await readTable(root, 't');
    expect(table.columns).toEqual(['id', 'n']);
    expect(table.rows.map((r) => r.id)).toEqual(['[a]', '[c]', '[d]']);
    expect(intCell('t', table.rows[0] ?? {}, 'n')).toBe(3);
    expect(intCell('t', table.rows[1] ?? {}, 'n')).toBeNull();
    expect(() => intCell('t', table.rows[2] ?? {}, 'n')).toThrow('t [d]: n is not an integer: x');
    expect(() => intCell('t', table.rows[0] ?? {}, 'zz')).toThrow('is not an integer');
    expect(boolCell('t', { id: '[a]', b: 'true' }, 'b')).toBe(true);
    expect(boolCell('t', { id: '[a]', b: 'false' }, 'b')).toBe(false);
    expect(() => boolCell('t', { id: '[a]', b: 'TRUE' }, 'b')).toThrow('t [a]: b is not a bool: TRUE');
    await expect(readTable(root, 'none')).rejects.toThrow('data table not found');
    writeFileSync(join(root, 'data', 'tables', 'short.csv'), 'a\nb\n');
    await expect(readTable(root, 'short')).rejects.toThrow('data table has no header');
  });
});

describe('bots', () => {
  const row = { id: '[duel]', minPlayers: 2, maxPartySize: 3, allowQueue: true, allowRoom: false };
  it('reads input commands and command names', () => {
    expect(inputOf({ command: 'tap', args: ['1', '2'] })).toEqual({ command: 'tap', args: ['1', '2'] });
    expect(inputOf({ command: 'key_down' })).toEqual({ command: 'key_down', args: [] });
    expect(inputOf({ command: 'go_to_scene', args: [] })).toBeNull();
    expect(inputOf({ command: 'tap', args: [1] })).toBeNull();
    expect(inputOf(null)).toBeNull();
    expect(commandNames([{ name: 'a.b' }, { x: 1 }, 'c'])).toEqual(['a.b']);
    expect(() => commandNames({})).toThrow('list_commands did not return a list');
    expect(oneCommand(['a.opponent_step', 'b.x'], '.opponent_step')).toBe('a.opponent_step');
    expect(() => oneCommand([], '.social_step')).toThrow('expected one content command ending with .social_step, found 0');
  });
  it('decides room modes and joins', () => {
    expect(roomCapable(row)).toBe(true);
    expect(roomCapable({ ...row, maxPartySize: 1 })).toBe(false);
    expect(roomCapable({ ...row, allowQueue: false, maxPartySize: 1, allowRoom: true })).toBe(true);
    expect(roomJoinCount(row, 5)).toBe(2);
    expect(roomJoinCount(row, 1)).toBe(1);
    expect(roomJoinCount({ ...row, allowRoom: true }, 5)).toBe(5);
    const other = { ...row, id: '[team]' };
    expect(rowOfMode([other, row], '[duel]')).toBe(row);
    expect(() => rowOfMode([row], '[team]')).toThrow('room_mode "[team]" is not a match_mode row with opponent bot clients');
    const bots: OpponentBot[] = [
      { name: 'opponent_1', row, request: () => ok(null), pendingJoin: null },
      { name: 'opponent_2', row, request: () => ok(null), pendingJoin: null },
      { name: 'opponent_3', row, request: () => ok(null), pendingJoin: null },
      { name: 'opponent_4', row: other, request: () => ok(null), pendingJoin: null },
    ];
    assignJoins(bots, [row, other], '[duel]', 'ABC');
    expect(bots.map((b) => b.pendingJoin)).toEqual(['ABC', 'ABC', null, null]);
    expect(() => {
      assignJoins(bots, [row], '', 'XYZ');
    }).toThrow('room_mode "" is not a match_mode row');
  });
  it('watches room_code and gives the room to opponent bot clients of the room_mode row', async () => {
    const gate = new BotGate();
    const states = [
      { room_code: '', room_mode: '' },
      { room_code: 'ABC', room_mode: '[duel]' },
      { room_code: '', room_mode: '' },
      { room_code: 'XYZ', room_mode: '[nope]' },
      { room_code: 'XYZ', room_mode: '[nope]' },
    ];
    let calls = 0;
    const main = (command: string) => {
      expect(command).toBe('get_state');
      const state = states[calls];
      calls += 1;
      if (calls >= states.length) gate.stop();
      return ok(state);
    };
    const duel = { ...row, maxPartySize: 2 };
    const bots: OpponentBot[] = [
      { name: 'opponent_1', row: duel, request: () => ok(null), pendingJoin: null },
      { name: 'opponent_2', row: duel, request: () => ok(null), pendingJoin: null },
    ];
    const logs: string[] = [];
    await roomWatch(gate, main, bots, [duel], 100, (line) => logs.push(line));
    expect(bots.map((b) => b.pendingJoin)).toEqual(['ABC', null]);
    expect(logs).toEqual(['room watch: room_mode "[nope]" is not a match_mode row with opponent bot clients']);
  }, 10_000);
  it('gates calls: pause waits for calls in flight, step mode opens only while stepping', async () => {
    const gate = new BotGate();
    expect(await gate.enter()).toBe(true);
    let paused = false;
    const pausing = gate.pause().then(() => {
      paused = true;
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(paused).toBe(false);
    gate.leave();
    await pausing;
    expect(paused).toBe(true);
    let entered = false;
    const next = gate.enter().then((v) => {
      entered = v;
    });
    gate.resume(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(entered).toBe(false);
    gate.setStepping(true);
    await next;
    expect(entered).toBe(true);
    gate.leave();
    gate.setStepping(false);
    gate.setStepping(false);
    const blocked = gate.enter();
    gate.stop();
    expect(await blocked).toBe(false);
  });
});

describe('launch', () => {
  it('makes LOCAL secrets of the documented forms', () => {
    const s = newLocalSecrets();
    expect(Buffer.from(s.accessTokenKey, 'base64')).toHaveLength(32);
    expect(s.accessTokenKey).not.toBe(s.updateSigningKey);
    for (const v of [s.iapAccountToken, s.devAccess, s.adminSecret]) expect(v).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
  it('starts the server process with node core/start.ts and the server start arguments in server/', () => {
    const secrets = { accessTokenKey: 'a', updateSigningKey: 'u', iapAccountToken: 'i', devAccess: 'd', adminSecret: 'x' };
    const sqlite = { kind: 'sqlite', file: '/db' } as const;
    const postgresql = { kind: 'postgresql', url: 'postgresql://postgres:pw@127.0.0.1:5/postgres' } as const;
    expect(serverSecretValues(secrets, sqlite)).toEqual({
      accessTokenKey: 'a', updateSigningKey: 'u', iapAccountToken: 'i', devAccess: 'd', 'adminSecret.ogw': 'x',
    });
    expect(serverSecretValues(secrets, postgresql)).toEqual({
      accessTokenKey: 'a', updateSigningKey: 'u', iapAccountToken: 'i', devAccess: 'd', 'adminSecret.ogw': 'x', db: postgresql.url,
    });
    const pgArgs = serverStartArgs({ root: '/r', port: 9, db: postgresql, matchmaker: false, secretFile: '/s' });
    expect(pgArgs).toEqual(['--env', 'LOCAL', '--port', '9', '--db', 'postgresql', '--secret-file', '/s']);
    const args = ['--env', 'LOCAL', '--port', '9', '--db', '/db', '--matchmaker', '--secret-file', '/i/server-secrets.json'];
    expect(serverStartArgs({ root: '/r', port: 9, db: sqlite, matchmaker: true, secretFile: '/i/server-secrets.json' })).toEqual(args);
    expect(serverLaunch({ root: '/r', port: 9, db: sqlite, matchmaker: false, secretFile: '/i/server-secrets.json' })).toEqual({
      command: process.execPath,
      args: ['core/start.ts', ...args.filter((a) => a !== '--matchmaker')],
      cwd: join('/r', 'server'),
    });
    expect(serverDataFolder('/r')).toBe(join('/r', 'server', 'build', 'data'));
  });

  it('runs populate with the remote test server of connect_server', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-populate-'));
    mkdirSync(join(root, 'server', 'core', 'testing', 'dev'), { recursive: true });
    mkdirSync(join(root, 'server', 'dev'), { recursive: true });
    writeFileSync(join(root, 'server', 'core', 'testing', 'dev', 'index.ts'),
      'export async function connect_server(url: string, data: string, dev: string) { return { url, data, dev }; }\n');
    writeFileSync(join(root, 'server', 'dev', 'populate.ts'),
      "import { writeFileSync } from 'node:fs';\nexport async function populate(server: unknown) { writeFileSync('out.json', JSON.stringify(server)); }\n");
    const secretFile = join(root, 'server-secrets.json');
    writeSecretFile(secretFile, { devAccess: 'dev-access-value', 'adminSecret.ogw': 'x' });
    expect(statSync(secretFile).mode & 0o777).toBe(0o600);
    expect(() => {
      writeSecretFile(secretFile, {});
    }).toThrow();
    const launch = populateLaunch({ root, serverUrl: 'http://127.0.0.1:5', secretFile });
    expect(launch.cwd).toBe(join(root, 'server'));
    expect(launch.args.slice(-4)).toEqual(['--', 'http://127.0.0.1:5', join(root, 'server', 'build', 'data'), secretFile]);
    expect(launch.args.join(' ')).not.toContain('dev-access-value');
    const result = await run(launch.command, launch.args, { cwd: launch.cwd, timeoutMs: 30_000 });
    expect(result.code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, 'server', 'out.json'), 'utf8'))).toEqual({ url: 'http://127.0.0.1:5', data: join(root, 'server', 'build', 'data'), dev: 'dev-access-value' });
  });
  it('picks the renderer and builds the Godot command line', () => {
    expect(['windows', 'macos', 'linux', 'android', 'ios', 'web'].map((p) => renderingMethod('godot', p))).toEqual([
      'forward_plus', 'forward_plus', 'forward_plus', 'mobile', 'mobile', 'gl_compatibility',
    ]);
    expect(() => renderingMethod('godot', 'switch')).toThrow('unknown platform: switch');
    const values = {
      OGW_SERVER_URL: 'http://h', OGW_INSTANCE_ID: 'i1', OGW_AUTOMATION_PORT: '5', OGW_AUTOMATION_TOKEN: 't',
      OGW_DEV_ACCOUNT: '', OGW_DEV_ACCESS: 'd', OGW_PLATFORM: 'ios',
    };
    const plan = { engine: 'godot', enginePath: '/bin/godot', renderingMethod: 'mobile' };
    expect(launchValueFileContent(values)).toEqual({
      OGW_SERVER_URL: 'http://h', OGW_INSTANCE_ID: 'i1', OGW_AUTOMATION_PORT: '5', OGW_AUTOMATION_TOKEN: 't',
      OGW_DEV_ACCESS: 'd', OGW_PLATFORM: 'ios',
    });
    expect(launchValueFileContent({ ...values, OGW_DEV_ACCOUNT: 'opponent_1' }).OGW_DEV_ACCOUNT).toBe('opponent_1');
    expect(clientLaunch(plan, '/g', true, '/i/main.launch-values.json')).toEqual({
      command: '/bin/godot',
      cwd: '/g',
      args: ['--path', join('/g', 'client'), '--rendering-method', 'mobile', '--headless', '--', '--launch-values=/i/main.launch-values.json'],
    });
    expect(clientLaunch(plan, '/g', false, '/v').args).not.toContain('--headless');
    expect(() => clientLaunch({ ...plan, engine: 'unity' }, '/g', false, '/v')).toThrow('not defined: the dev run of engine unity');
    // movie maker: recording flags before the user arguments
    const movie = clientLaunch(plan, '/g', false, '/v', { file: '/t/raw.avi', resolution: [1920, 1080] }).args;
    const split = movie.indexOf('--');
    expect(movie.slice(0, split)).toEqual(expect.arrayContaining(['--resolution', '1920x1080', '--write-movie', '/t/raw.avi', '--fixed-fps', '60']));
    expect(movie.slice(split)).toEqual(['--', '--launch-values=/v']);
  });
});

describe('prepare and qa', () => {
  const settings = (patch: Partial<HarnessSettings>) => ({ maxConcurrentInstances: 4, playInstances: 2, ...patch }) as HarnessSettings;
  it('checks the concurrency settings', () => {
    expect(concurrencyLimit(settings({}))).toBe(4);
    expect(concurrencyLimit(settings({ maxConcurrentInstances: 2, playInstances: 2 }))).toBe(2);
    expect(() => concurrencyLimit(settings({ maxConcurrentInstances: null }))).toThrow('run update env first');
    expect(() => concurrencyLimit(settings({ maxConcurrentInstances: 1, playInstances: 1 }))).toThrow('must be 2 or more');
    expect(() => concurrencyLimit(settings({ playInstances: 5 }))).toThrow('more than maxConcurrentInstances');
  });
  it('picks the platform and the opponent rows', () => {
    expect(instancePlatform({ buildPlatforms: ['web'] }, undefined)).toBe('web');
    expect(instancePlatform({ buildPlatforms: ['web'] }, 'ios')).toBe('ios');
    expect(() => instancePlatform({}, undefined)).toThrow('buildPlatforms is empty');
    const a = { id: '[a]', minPlayers: 3, maxPartySize: 1, allowQueue: true, allowRoom: false };
    const b = { ...a, id: '[b]', minPlayers: 1 };
    expect(opponentRows([a, b, { ...a, id: '[c]', minPlayers: 2 }]).map((r) => r.id)).toEqual(['[a]', '[a]', '[c]']);
  });
  it('knows the input and refused commands and the help text', () => {
    expect(INPUT_COMMANDS).toHaveLength(16);
    expect(isInputCommand('pad_axis')).toBe(true);
    expect(isInputCommand('go_to_scene')).toBe(false);
    for (const c of ['set_step_mode', 'leave_match', 'step', 'capture_screen', 'capture_video']) expect(isRefusedByCommand(c)).toBe(true);
    expect(isRefusedByCommand('get_state')).toBe(false);
    const help = inputHelp();
    expect(help).toContain('  drag: x1, y1, x2, y2 (real), ms (integer >= 0)');
    expect(help).toContain('mouse buttons: left, right, middle');
    expect(help).toContain('gamepad buttons: a, b, x, y, back, guide, start');
    expect(help).toContain('trigger_right (0 to 1)');
    expect(help).toContain('{"steps": [{"atMs": <ms>, "command": "<input command>", "args": ["<argument>", ...]}, ...]}');
    expect(help).toContain('plus the time that step holds');
    expect(help).toContain('for text the character count times one frame (1000 / game');
    expect(inputHoldMs('drag', ['0', '0', '1', '1', '700'], 60)).toBe(700);
    expect(inputHoldMs('key', ['A'], 60)).toBe(0);
    expect(inputHoldMs('key', ['A', 'x'], 60)).toBe(0);
    expect(inputHoldMs('tap', ['1', '2'], 60)).toBe(0);
    expect(inputHoldMs('text', ['abc'], 60)).toBe(50);
  });
  it('marks the same input and step commands as the QACore built-in command table of qa-core.md', () => {
    const doc = readFileSync(join(import.meta.dirname, '..', '..', '..', '..', '..', 'skills', 'client-core', 'modules', 'qa-core.md'), 'utf8');
    const builtins = [...parseQaBuiltins(doc)];
    expect(INPUT_COMMANDS.map((c) => c.name).sort()).toEqual(builtins.filter(([, kind]) => kind === 'input').map(([name]) => name).sort());
    expect([...STEP_COMMANDS].sort()).toEqual(builtins.filter(([, kind]) => kind === 'step').map(([name]) => name).sort());
  });
  it('computes request time limits and checks ids', () => {
    expect(requestTimeoutMs(1000, 'tap', ['1', '2'])).toBe(61_000);
    expect(requestTimeoutMs(1000, 'drag', ['1', '2', '3', '4', '500'])).toBe(61_500);
    expect(requestTimeoutMs(1000, 'key', ['a', '200'])).toBe(61_200);
    expect(requestTimeoutMs(1000, 'capture_video', ['3000'])).toBe(64_000);
    expect(requestTimeoutMs(1000, 'step', ['x'])).toBe(61_000);
    expect(requestTimeoutMs(1000, 'key', ['a', '1e3'])).toBe(61_000);
    // the request time limit and the script hold time read the same ms argument
    for (const [command, args] of [['drag', ['1', '2', '3', '4', '750']], ['key', ['Space', '40']], ['tap', ['1', '2']]] as const) {
      expect(requestTimeoutMs(1000, command, args) - 61_000).toBe(inputHoldMs(command, args, 60));
    }
    expect(inputHoldMs('capture_video', ['3000'], 60)).toBe(0);
    expect(() => {
      checkInstanceId('A/b');
    }).toThrow('invalid instance id: A/b');
    expect(() => {
      checkInstanceId('ok_1-x');
    }).not.toThrow();
  });
});

describe('playAccessRefusal', () => {
  it('takes input, capture, observation and step mode, and refuses setup, restart, stop and framesDir', () => {
    const req = (client: string, command: string): Record<string, unknown> => ({ client, command, args: [] });
    for (const command of [...INPUT_COMMANDS.map((c) => c.name), 'capture_screen', 'capture_video', 'extract_logs', 'get_telemetry', 'get_state', 'set_step_mode', 'step']) {
      expect(playAccessRefusal('/request', req('main', command))).toBeNull();
    }
    for (const command of ['get_state', 'set_step_mode', 'leave_match', 'step']) expect(playAccessRefusal('/request', req('opponent_1', command))).toBeNull();
    expect(playAccessRefusal('/request', { command: 'get_state' })).toBeNull();
    for (const path of ['/bots/pause', '/bots/resume', '/stepping']) expect(playAccessRefusal(path, {})).toBeNull();
    expect(playAccessRefusal('/request', req('main', 'leave_match'))).toBe('the play access does not send leave_match to main');
    expect(playAccessRefusal('/request', req('main', 'set_user_state'))).toBe('the play access does not send set_user_state to main');
    expect(playAccessRefusal('/request', req('main', 'go_to_scene'))).toBe('the play access does not send go_to_scene to main');
    expect(playAccessRefusal('/request', req('opponent_1', 'battle.opponent_step'))).toBe('the play access does not send battle.opponent_step to opponent_1');
    expect(playAccessRefusal('/request', req('social', 'tap'))).toBe('the play access does not send tap to social');
    expect(playAccessRefusal('/request', { ...req('main', 'capture_video'), framesDir: '/x' })).toBe('the play access does not take framesDir');
    expect(playAccessRefusal('/restart', {})).toBe('the play access does not allow /restart');
    expect(playAccessRefusal('/stop', {})).toBe('the play access does not allow /stop');
  });
});
