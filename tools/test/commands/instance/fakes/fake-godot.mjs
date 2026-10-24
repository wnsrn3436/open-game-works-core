// A fake Godot dev run client that speaks the QACore automation channel (qa-core `### automation channel`).
// Behaviour comes from the JSON file in FAKE_GODOT_CONFIG; every request is logged to FAKE_LOG_DIR/<client>.jsonl.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
if (argv.includes('--import')) {
  // engine import: makes <path>/.godot/ unless FAKE_IMPORT_FAIL is set, and logs the call
  const project = argv[argv.indexOf('--path') + 1];
  appendFileSync(join(process.env.FAKE_LOG_DIR, 'import.log'), `${argv.join(' ')}\n`);
  if (process.env.FAKE_IMPORT_FAIL) {
    process.stderr.write('import broke\n');
    process.exit(3);
  }
  mkdirSync(join(project, '.godot'), { recursive: true });
  process.exit(0);
}
// launch values: the JSON object file of the user argument --launch-values=<path> (client-core engines/godot)
const user = argv.slice(argv.indexOf('--') + 1);
const valueFile = user.find((a) => a.startsWith('--launch-values='))?.slice('--launch-values='.length);
const values = valueFile === undefined ? {} : JSON.parse(readFileSync(valueFile, 'utf8'));
const value = (name) => values[`OGW_${name.toUpperCase().replaceAll('-', '_')}`] ?? '';
const name = value('dev-account') || 'main';
const logDir = process.env.FAKE_LOG_DIR;
writeFileSync(join(logDir, `${name}.args.json`), JSON.stringify(argv));
// the movie maker: the recording file is there from the start
if (argv.includes('--write-movie')) writeFileSync(argv[argv.indexOf('--write-movie') + 1], 'AVI');
writeFileSync(join(logDir, `${name}.values.json`), JSON.stringify(values));
// stepEffects[n] of the config applies to the state and telemetry marks when the n-th `step` (from 0, counted from the
// last config change) passes; its `fail` fails that step instead
let configText = '';
let stepCount = 0;
let stepMarks = [];
const readConfig = () => {
  const text = readFileSync(process.env.FAKE_GODOT_CONFIG, 'utf8');
  if (text !== configText) {
    configText = text;
    stepCount = 0;
    stepMarks = [];
  }
  return JSON.parse(text);
};
const mineOf = (config) => ({ ...(config.clients?.default ?? {}), ...(config.clients?.[name] ?? {}) });
let config = readConfig();
let mine = mineOf(config);
if (mine.exitOnStart !== undefined) process.exit(mine.exitOnStart);

const state = {
  boot_stage: 'Done',
  user_id: name === 'main' ? 42 : 0,
  step_mode: false,
  match_state: null,
  room_code: null,
  room_mode_id: null,
  room_mode: null,
  content: {},
  invariant_failures: [],
  softlock: null,
  ...(mine.state ?? {}),
};
const bootStages = [...(mine.bootStages ?? [])];
const sequences = structuredClone(mine.sequences ?? {});
let restarts = 0;

function log(entry) {
  appendFileSync(join(logDir, `${name}.jsonl`), `${JSON.stringify(entry)}\n`);
}

function answer(command, args) {
  if (mine.fail?.[command] !== undefined) return { ok: false, result: mine.fail[command] };
  switch (command) {
    case 'get_state':
      if (bootStages.length > 0) state.boot_stage = bootStages.shift();
      return { ok: true, result: { ...state, ...(mine.stateNow ?? {}), ...(config.stateByInstance?.[value('instance-id')] ?? {}), restarts } };
    case 'set_step_mode':
      state.step_mode = args[0] === 'on';
      return { ok: true, result: null };
    case 'step': {
      if (!state.step_mode) return { ok: false, result: 'not in step mode' };
      const effect = mine.stepEffects?.[stepCount] ?? {};
      stepCount += 1;
      if (effect.fail !== undefined) return { ok: false, result: effect.fail };
      Object.assign(state, effect.state ?? {});
      stepMarks.push(...(effect.marks ?? []));
      return { ok: true, result: null };
    }
    case 'leave_match':
      state.match_state = 'None';
      return { ok: true, result: null };
    case 'list_commands':
      return { ok: true, result: (mine.commands ?? []).map((n) => ({ name: n, description: '', args: [] })) };
    case 'get_telemetry': {
      const base = config.telemetryByInstance?.[value('instance-id')] ?? config.telemetry ?? { started_at: Date.now(), inputs: [], rewards: [], marks: [], idle_spans: [], goal_intervals: [], scene_loads: [], dropped: 0 };
      if (stepMarks.length === 0) return { ok: true, result: base };
      return { ok: true, result: { ...base, marks: [...(base.marks ?? []), ...stepMarks] } };
    }
    case 'extract_logs':
      return { ok: true, result: config.logs ?? [] };
    case 'capture_screen':
      return { ok: true, result: null, bytes: Buffer.from(`PNG-${name}`).toString('base64') };
    default:
      break;
  }
  if (sequences[command] && sequences[command].length > 0) {
    const next = sequences[command].length > 1 ? sequences[command].shift() : sequences[command][0];
    return next;
  }
  return mine.results?.[command] ?? { ok: true, result: null };
}

let socket;
function connect() {
  socket = new WebSocket(`ws://127.0.0.1:${value('automation-port')}`);
  socket.addEventListener('open', () => {
    socket.send(JSON.stringify({ token: mine.badToken ? 'wrong' : value('automation-token') }));
  });
  socket.addEventListener('message', async (event) => {
    const request = JSON.parse(String(event.data));
    config = readConfig();
    mine = mineOf(config);
    log({ command: request.command, args: request.args, at: Date.now() });
    // a crash on this command: the process ends without an answer
    if (mine.exitOn?.[request.command] !== undefined) process.exit(mine.exitOn[request.command]);
    if (request.command === 'capture_video' && mine.fail?.capture_video === undefined) {
      const n = mine.videoFrames ?? 3;
      for (let i = 0; i < n; i++) socket.send(JSON.stringify({ id: request.id, frame: i, bytes: Buffer.from(`FRAME-${i}`).toString('base64') }));
      socket.send(JSON.stringify({ id: request.id, ok: true, result: { frame_count: n, fps: 30 }, bytes: '' }));
      return;
    }
    if (mine.delayMs?.[request.command]) await new Promise((r) => setTimeout(r, mine.delayMs[request.command]));
    const out = answer(request.command, request.args);
    socket.send(JSON.stringify({ id: request.id, ok: out.ok, result: out.result ?? null, bytes: out.bytes ?? '' }));
    if ((request.command === 'restart' || request.command === 'set_language') && out.ok) {
      restarts += 1;
      const old = socket;
      setTimeout(() => {
        old.close();
        connect();
      }, 50);
    }
  });
}
connect();
