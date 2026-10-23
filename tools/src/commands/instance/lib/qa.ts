/** QACore built-in commands with the input mark, and their arguments (qa-core `### built-in command`). */
export const INPUT_COMMANDS: readonly { name: string; args: string }[] = [
  { name: 'tap', args: 'x, y (real)' },
  { name: 'tap_anchor', args: 'anchor name, anchor key (ID name; omit to find without a key)' },
  { name: 'drag', args: 'x1, y1, x2, y2 (real), ms (integer >= 0)' },
  { name: 'key', args: 'key name, ms (integer >= 0; default 0)' },
  { name: 'text', args: 'string (1 to QACore.textMaxChars characters)' },
  { name: 'touch_down', args: 'touch index (integer >= 0 and < InputCore.maxJudgePointers), x, y (real)' },
  { name: 'touch_move', args: 'touch index, x, y (real)' },
  { name: 'touch_up', args: 'touch index' },
  { name: 'key_down', args: 'key name' },
  { name: 'key_up', args: 'key name' },
  { name: 'mouse_move', args: 'x, y (real)' },
  { name: 'mouse_down', args: 'mouse button name, x, y (real)' },
  { name: 'mouse_up', args: 'mouse button name, x, y (real)' },
  { name: 'pad_button_down', args: 'gamepad button name' },
  { name: 'pad_button_up', args: 'gamepad button name' },
  { name: 'pad_axis', args: 'gamepad axis name, value (real)' },
];

/** Key name rule of each engine (the `InputCore` key name of the engine implementation rules). */
export const KEY_NAMES: Readonly<Record<string, string>> = {
  godot: 'the names OS.get_keycode_string() gives, for example A, Space, Escape, Enter, Tab, Backspace, Left, Up, Shift, F1',
};

export const MOUSE_BUTTONS = ['left', 'right', 'middle'] as const;

/** InputCore gamepad button names. */
export const PAD_BUTTONS = [
  'a', 'b', 'x', 'y', 'back', 'guide', 'start', 'left_stick', 'right_stick', 'left_shoulder', 'right_shoulder',
  'dpad_up', 'dpad_down', 'dpad_left', 'dpad_right',
] as const;

/** InputCore gamepad axis names and ranges. */
export const PAD_AXES = [
  { name: 'left_x', range: '-1 to 1' },
  { name: 'left_y', range: '-1 to 1' },
  { name: 'right_x', range: '-1 to 1' },
  { name: 'right_y', range: '-1 to 1' },
  { name: 'trigger_left', range: '0 to 1' },
  { name: 'trigger_right', range: '0 to 1' },
] as const;

/** Built-in commands with the step mark. */
export const STEP_COMMANDS = ['set_step_mode', 'leave_match', 'step'] as const;

const inputNames = new Set(INPUT_COMMANDS.map((c) => c.name));

/** Built-in commands with an ms argument (qa-core `### built-in command`), and its index. */
const MS_ARG: Readonly<Record<string, number>> = { drag: 4, key: 1, capture_video: 0, step: 0 };

/** The ms argument of a built-in command: a whole number of ms, or 0 when the command has none or it is not one. */
export function msArgument(command: string, args: readonly string[]): number {
  const index = MS_ARG[command];
  const value = index === undefined ? undefined : args[index];
  return value !== undefined && /^[0-9]{1,18}$/.test(value) ? Number(value) : 0;
}

/**
 * How long the input command holds the client's input queue: the ms argument of `drag` and `key`, one client frame
 * (1000 / `targetFps` ms) per character of `text` (rounded up to a whole ms), 0 for the others.
 */
export function inputHoldMs(command: string, args: readonly string[], targetFps: number): number {
  // Godot strings are code points: one text input per code point, as the client puts them in
  if (command === 'text') return Math.ceil((Array.from(args[0] ?? '').length * 1000) / targetFps);
  return inputNames.has(command) ? msArgument(command, args) : 0;
}

export function isInputCommand(name: string): boolean {
  return inputNames.has(name);
}

/** Built-in commands `ogw command` does not send. */
export function isRefusedByCommand(name: string): boolean {
  return (STEP_COMMANDS as readonly string[]).includes(name) || name === 'capture_screen' || name === 'capture_video';
}

/** Built-in commands the play token sends to the client `main`: input, capture, observation and step mode. */
const PLAY_MAIN_COMMANDS: ReadonlySet<string> = new Set([
  ...inputNames,
  'capture_screen',
  'capture_video',
  'extract_logs',
  'get_telemetry',
  'get_state',
  'set_step_mode',
  'step',
]);

/** Built-in commands the play token sends to a bot client: what `ogw step-mode` and `ogw step` send. */
const PLAY_BOT_COMMANDS: ReadonlySet<string> = new Set(['get_state', ...STEP_COMMANDS]);

/** Control paths the play token may call besides `/request`: the bot loop control of `ogw step-mode` and `ogw step`. */
const PLAY_PATHS: ReadonlySet<string> = new Set(['/bots/pause', '/bots/resume', '/stepping']);

/**
 * Why the supervisor refuses a control request made with the play token (ogw.md `## runner`), or null when it
 * takes it. The play token sends no setup command (`set_user_state`, content commands), no `restart`, no `/stop`,
 * and no `framesDir` (the supervisor would write files where the caller says).
 */
export function playAccessRefusal(path: string, body: Readonly<Record<string, unknown>>): string | null {
  if (PLAY_PATHS.has(path)) return null;
  if (path !== '/request') return `the play access does not allow ${path}`;
  if (body.framesDir !== undefined) return 'the play access does not take framesDir';
  const client = typeof body.client === 'string' ? body.client : 'main';
  const command = String(body.command);
  const allowed = client === 'main' ? PLAY_MAIN_COMMANDS : PLAY_BOT_COMMANDS;
  return allowed.has(command) ? null : `the play access does not send ${command} to ${client}`;
}

/** Help text of `ogw input --help`. */
export function inputHelp(): string {
  return [
    'usage: ogw input <instance> <command> <argument...>',
    '       ogw input <instance> --script <file> [--video]',
    '',
    'input commands (QACore built-in commands with the input mark):',
    ...INPUT_COMMANDS.map((c) => `  ${c.name}: ${c.args}`),
    '',
    'coordinates are window pixels; the origin is the top left of the window, as in a capture.',
    '',
    'key names by engine:',
    ...Object.entries(KEY_NAMES).map(([engine, rule]) => `  ${engine}: ${rule}`),
    `mouse buttons: ${MOUSE_BUTTONS.join(', ')}`,
    `gamepad buttons: ${PAD_BUTTONS.join(', ')}`,
    `gamepad axes: ${PAD_AXES.map((a) => `${a.name} (${a.range})`).join(', ')}`,
    '',
    'timed input script:',
    '  {"steps": [{"atMs": <ms>, "command": "<input command>", "args": ["<argument>", ...]}, ...]}',
    '  atMs is the time from the start. It is not less than the atMs of the step before plus the time that step holds',
    '  the input: the ms argument of drag and key, and for text the character count times one frame (1000 / game',
    '  settings targetFps ms), rounded up to a whole ms. One input runs at a time. Put inputs in at the same time with',
    '  the _down and _up commands.',
    '  Each step prints its atMs, the unix ms it was put in, the command, ok or failed, and the result. When a step',
    '  cannot be put in (the client or its automation channel is gone), the steps after it are not put in.',
    '  With --video the video runs from the first step until the last step has held the input and',
    '  QACore.feedbackWindowMs has passed; that length is at most QACore.videoMaxMs.',
  ].join('\n');
}
