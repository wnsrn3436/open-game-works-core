import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createContext, type Context } from '../../../../src/lib/command.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import { StaticContext, type Finding } from '../../../../src/commands/check/static/lib/context.ts';
import { makeWorkspace } from '../../../helpers/workspace.ts';

export type Files = Record<string, string | Buffer | object>;

export function writeFiles(root: string, files: Files): void {
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(dirname(full), { recursive: true });
    const data = typeof content === 'string' || Buffer.isBuffer(content) ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(full, data);
  }
}

let harness: string | null = null;

/** A copy of the harness docs, settings and schemas in a git repo of the test's temp folder, made once per test file. */
function testHarness(): string {
  harness ??= makeWorkspace().harness;
  return harness;
}

export function testContext(cwd: string, env: NodeJS.ProcessEnv = {}): Context {
  return createContext({
    cwd,
    env: { ...process.env, OGW_HARNESS_ROOT: testHarness(), ...env },
    stdin: () => Promise.resolve(''),
    stderr: () => undefined,
  });
}

/** A static context over a temporary folder holding `files` (no git; the file list is the given paths). */
export function memContext(files: Files, env: NodeJS.ProcessEnv = {}): StaticContext {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-static-')));
  writeFiles(root, files);
  const game: GameRepo = { name: 'g', root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false };
  return new StaticContext(testContext(root, env), game, Object.keys(files).sort());
}

const op = (name: string, ...inputs: ('translationKey' | 'other')[]) => ({ name, inputs });
const specModule = (name: string, side: 'client' | 'server', operations: ReturnType<typeof op>[]) => ({
  name,
  side,
  lifecycle: side === 'client',
  dependencies: [],
  optionalDependencies: [],
  devDependencies: [],
  settings: [],
  tables: [],
  operations,
});

/** A `core-spec.json` with the operations the data literal check reads. */
export const CORE_SPEC = {
  version: '1.0.0',
  modules: [
    specModule('LocalizationCore', 'client', [op('get_text', 'translationKey', 'other'), op('bind_text', 'other', 'translationKey')]),
    specModule('MessageCore', 'client', [op('show_toast', 'translationKey', 'other')]),
    specModule('RequirementCore', 'client', [op('register_judge', 'other', 'other', 'other', 'translationKey')]),
    specModule('UICore', 'client', [op('open_panel', 'other')]),
    specModule('mailbox', 'server', [op('send_mail', 'translationKey')]),
  ],
};

/** `where | message` lines, sorted, for exact comparison. */
export function lines(findings: readonly Finding[]): string[] {
  return findings.map((f) => `${f.where} | ${f.message}`).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}

/** `lines` of the absence failures only. */
export function absentLines(findings: readonly Finding[]): string[] {
  return lines(findings.filter((f) => f.absent === true));
}

/** Core class stubs a game's `client/core/` has. */
export const CORE_STUBS: Files = {
  'client/core/ui_core/ui_button.gd': 'class_name UIButton\nextends Node\n\n@export var action: String = ""\n',
  'client/core/ui_core/ui_anchor.gd': 'class_name UIAnchor\nextends Node\n\n@export var anchor_name: String = ""\n',
  'client/core/virtual_pad_core/virtual_pad_core.gd': 'class_name VirtualPadCore\nextends RefCounted\n\nenum JoystickMode { FIXED, FLOATING, FOLLOWING }\n',
  'client/core/virtual_pad_core/virtual_pad_layout.gd':
    'class_name VirtualPadLayout\nextends Control\n\n@export var joystick_mode: VirtualPadCore.JoystickMode = VirtualPadCore.JoystickMode.FLOATING\n',
  'client/core/virtual_pad_core/virtual_button.gd': 'class_name VirtualButton\nextends Control\n\n@export var action: StringName\n',
  'client/core/virtual_pad_core/virtual_joystick.gd':
    'class_name VirtualJoystick\nextends Control\n\n@export var action_negative_x: StringName\n@export var action_positive_x: StringName\n@export var action_negative_y: StringName\n@export var action_positive_y: StringName\n',
  'client/generated/data/game_data.gd': [
    'class_name GameData',
    'extends RefCounted',
    '',
    'enum RequirementType { NONE, ITEM_COUNT, LEVEL }',
    '',
    'class ItemRow extends RefCounted:',
    '\tvar id: int',
    '\tvar price: int',
    '\tvar tags: PackedInt32Array',
    '\tvar cost: Array[CoreContract.ItemAmount]',
    '\tvar cells: Array[Array]',
    '',
    'class ItemTable extends RefCounted:',
    '\tstatic func all_rows() -> Array[GameData.ItemRow]:',
    '\t\treturn []',
    '\tstatic func get_row(id: int) -> GameData.ItemRow:',
    '\t\treturn null',
    '',
  ].join('\n'),
  'client/generated/contract/core_contract.gd': 'class_name CoreContract\nextends RefCounted\n\nclass ItemAmount extends RefCounted:\n\tvar item_id: int\n\tvar amount: int\n',
};

/** The same order as `lines`. */
export function sorted(list: readonly string[]): string[] {
  return [...list].sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
}
