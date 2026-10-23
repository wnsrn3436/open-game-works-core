import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requireEngine, toolProgram } from '../../../../src/commands/env/api.ts';
import { installPackage } from '../../../../src/commands/core/lib/engine-packages.ts';
import { GDLINT_OFF_RULES, GDSCRIPT_ERROR_WARNINGS, godotTypeCheck, type GodotProject } from '../../../../src/commands/code/gdscript-checks.ts';
import { engineLint, engineTypeCheck, gdFiles, withErrorWarnings } from '../../../../src/commands/code/lib/gdscript.ts';
import type { CheckTarget } from '../../../../src/commands/code/lib/target.ts';
import type { Context } from '../../../../src/lib/command.ts';
import { LIMITS } from '../../../../src/lib/limits.ts';
import { bothModes, type OneProcessFault } from '../../../helpers/godot.ts';
import { gitOnlyHarness } from '../../../helpers/workspace.ts';

vi.mock('../../../../src/commands/env/api.ts', () => ({ requireEngine: vi.fn(), toolProgram: vi.fn() }));
/** GUT from `engine.json` `gut` puts `addons/gut/gut_test.gd` into the project. */
vi.mock('../../../../src/commands/core/lib/engine-packages.ts', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  installPackage: vi.fn(),
}));

function program(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function core(files: Record<string, string>): CheckTarget {
  const root = mkdtempSync(join(tmpdir(), 'ogw-gd-'));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return { side: 'core', root, repo: root, files: Object.keys(files).sort() };
}

const env: NodeJS.ProcessEnv = { ...process.env, OGW_HARNESS_ROOT: gitOnlyHarness() };
const ctx = { env } as Context;
const ENGINE_JSON = JSON.stringify({ godot: '4.5.1.stable', gut: { url: 'https://example.invalid/gut.zip', sha256: 'a'.repeat(64) } });
const FILES = {
  'client/godot/engine.json': ENGINE_JSON,
  'client/godot/project.godot': 'config_version=5\n',
  'client/godot/core/a.gd': 'x',
  'client/godot/core/bad.gd': 'x',
  'client/godot/core/Bad_name.gd': 'x',
  'client/godot/addons/gut/g.gd': 'x',
};

let bin = '';
let log = '';

beforeEach(() => {
  bin = mkdtempSync(join(tmpdir(), 'ogw-gd-bin-'));
  log = join(bin, 'log');
  vi.mocked(requireEngine).mockReset();
  vi.mocked(toolProgram).mockReset();
  vi.mocked(installPackage).mockReset();
  vi.mocked(installPackage).mockImplementation((_ctx, item, project) => {
    mkdirSync(join(project, 'addons', item.name), { recursive: true });
    writeFileSync(join(project, 'addons', item.name, `${item.name}_test.gd`), 'class_name GutTest\n');
    return Promise.resolve();
  });
});

function workFolder(): string {
  return mkdtempSync(join(tmpdir(), 'ogw-gd-work-'));
}

describe('gdFiles', () => {
  it('lists the .gd files of the engine project without addons/', () => {
    expect(gdFiles(core(FILES), 'godot')).toEqual(['client/godot/core/Bad_name.gd', 'client/godot/core/a.gd', 'client/godot/core/bad.gd']);
  });
});

describe('engineTypeCheck', () => {
  it('imports, then checks each script and reports parse errors at file:line', async () => {
    const godot = program(
      bin,
      'godot',
      `echo "$@" >> ${log}\n${bothModes(`case "$*" in\n  *res://core/bad.gd*) echo 'SCRIPT ERROR: Parse Error: Identifier "x" not declared.'; echo '   at: GDScript::reload (res://core/bad.gd:3)'; exit 1;;\nesac\nexit 0`)}`,
    );
    vi.mocked(requireEngine).mockResolvedValue(godot);
    const target = core(FILES);
    const work = workFolder();
    expect(await engineTypeCheck(ctx, target, ['godot'], work)).toEqual(['client/godot/core/bad.gd:3 Parse Error: Identifier "x" not declared.']);
    expect(requireEngine).toHaveBeenCalledWith(ctx, 'godot', '4.5.1.stable');
    const project = join(work, 'godot', 'client', 'godot');
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls[0]).toBe(`--headless --path ${project} --import`);
    // one Godot process loads every script
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatch(new RegExp(`^--headless --path ${project} -s \\S+/ogw_check\\.gd -- \\S+/files\\.txt$`));
    expect(await engineTypeCheck(ctx, target, ['unity'], workFolder())).toEqual([]);
  });

  it('does not run a passed check of the same inputs again, and runs it again when a file or the checked files change or it failed', async () => {
    const godot = program(bin, 'godot', `echo "$@" >> ${log}\ncase "$*" in\n  *res://core/bad.gd*) [ -f core/fixed ] && exit 0; echo 'SCRIPT ERROR: Parse Error: x'; echo '   at: GDScript::reload (res://core/bad.gd:1)'; exit 1;;\nesac\nexit 0`);
    vi.mocked(requireEngine).mockResolvedValue(godot);
    const calls = (): number => readFileSync(log, 'utf8').trim().split('\n').length;
    const clean = { ...FILES, 'client/godot/core/bad.gd': 'y' };
    const fixedTarget = core({ ...clean, 'client/godot/core/fixed': '' });
    // a failing check is run each time
    const failing = core(FILES);
    expect(await engineTypeCheck(ctx, failing, ['godot'], workFolder())).toHaveLength(1);
    const afterFail = calls();
    expect(await engineTypeCheck(ctx, failing, ['godot'], workFolder())).toHaveLength(1);
    expect(calls()).toBe(2 * afterFail);
    // a passing one is not run again for the same inputs
    expect(await engineTypeCheck(ctx, fixedTarget, ['godot'], workFolder())).toEqual([]);
    const afterPass = calls();
    expect(await engineTypeCheck(ctx, fixedTarget, ['godot'], workFolder())).toEqual([]);
    expect(calls()).toBe(afterPass);
    // another file content is another input
    writeFileSync(join(fixedTarget.root, 'client/godot/core/a.gd'), 'z');
    expect(await engineTypeCheck(ctx, fixedTarget, ['godot'], workFolder())).toEqual([]);
    expect(calls()).toBeGreaterThan(afterPass);
  });

  it('runs a passed check again for a larger list of checked files or another engine binary', async () => {
    const bad = `case "$*" in\n  *res://core/bad.gd*) echo 'SCRIPT ERROR: Parse Error: x'; echo '   at: GDScript::reload (res://core/bad.gd:1)'; exit 1;;\nesac\nexit 0`;
    const godot = program(bin, 'godot', `echo "$@" >> ${log}\n${bothModes(bad)}`);
    const root = core(FILES).root;
    const project: GodotProject = { root, folder: 'client/godot', repoPathOf: (res) => `client/godot/${res.slice('res://'.length)}` };
    const calls = (): number => readFileSync(log, 'utf8').trim().split('\n').length;
    expect(await godotTypeCheck(godot, project, ['client/godot/core/a.gd'], env)).toEqual([]);
    const afterPass = calls();
    expect(await godotTypeCheck(godot, project, ['client/godot/core/a.gd'], env)).toEqual([]);
    expect(calls()).toBe(afterPass);
    // the same project files with the failing file added to the checked files
    expect(await godotTypeCheck(godot, project, ['client/godot/core/a.gd', 'client/godot/core/bad.gd'], env)).toEqual([
      { path: 'client/godot/core/bad.gd', line: 1, message: 'Parse Error: x' },
    ]);
    // another engine binary at the same path, in which a.gd fails
    const afterFail = calls();
    program(bin, 'godot', `echo "$@" >> ${log}\n${bothModes(`case "$*" in\n  *res://core/a.gd*) echo 'SCRIPT ERROR: Parse Error: new engine'; echo '   at: GDScript::reload (res://core/a.gd:2)'; exit 1;;\nesac\nexit 0`)}`);
    expect(await godotTypeCheck(godot, project, ['client/godot/core/a.gd'], env)).toEqual([
      { path: 'client/godot/core/a.gd', line: 2, message: 'Parse Error: new engine' },
    ]);
    expect(calls()).toBeGreaterThan(afterFail);
  });

  const faults: [string, OneProcessFault][] = [
    ['an error line before the first script', { before: `echo "ERROR: Cannot open file 'res://missing_theme.tres'." >&2` }],
    ['an error line between two scripts', { between: 'echo "SCRIPT ERROR: Invalid call." >&2' }],
    ['an error line after the last script', { after: 'echo "ERROR: 1 resources still in use at exit." >&2' }],
    ['a script error line after the last script', { after: 'echo "SCRIPT ERROR: Invalid call." >&2' }],
    ['an exit code other than 0', { code: 3 }],
    ['a timeout', { after: "trap 'exit 0' TERM; sleep 30 & wait" }],
  ];
  it.each(faults)('checks each file in its own process when the one process run has %s', async (_name, fault) => {
    const body = `case "$*" in\n  *--check-only*res://core/bad.gd*) echo 'SCRIPT ERROR: Parse Error: x'; echo '   at: GDScript::reload (res://core/bad.gd:3)'; exit 1;;\n  *--check-only*res://core/a.gd*) [ -z "$ONE_PROCESS" ] && { echo 'ERROR: only in its own process'; exit 1; };;\nesac\nexit 0`;
    vi.mocked(requireEngine).mockResolvedValue(program(bin, 'godot', `echo "$@" >> ${log}\n${bothModes(body, fault)}`));
    const limits = LIMITS as { programMs: number };
    const programMs = limits.programMs;
    limits.programMs = 3000;
    try {
      expect(await engineTypeCheck(ctx, core(FILES), ['godot'], workFolder())).toEqual([
        'client/godot/core/a.gd:1 ERROR: only in its own process',
        'client/godot/core/bad.gd:3 Parse Error: x',
      ]);
    } finally {
      limits.programMs = programMs;
    }
    const calls = readFileSync(log, 'utf8').trim().split('\n');
    expect(calls.filter((call) => / -s /.test(call))).toHaveLength(1);
    expect(calls.filter((call) => call.includes('--check-only --script')).map((call) => call.replace(/^.* --script /, '')).sort()).toEqual([
      'res://core/Bad_name.gd', 'res://core/a.gd', 'res://core/bad.gd',
    ]);
  });

  it('fails when the import fails', async () => {
    vi.mocked(requireEngine).mockResolvedValue(program(bin, 'godot', 'case "$*" in *--import*) echo "ERROR: import broke"; exit 4;; esac\nexit 0'));
    expect(await engineTypeCheck(ctx, core(FILES), ['godot'], workFolder())).toEqual(['client/godot:1 godot --import failed (4): ERROR: import broke']);
  });

  it('checks scripts that extend GUT classes against GUT from engine.json, not the addons/ of the checkout', async () => {
    // Fake Godot: a script that extends GutTest fails unless the project has addons/gut/gut_test.gd.
    const godot = program(
      bin,
      'godot',
      bothModes(`case "$*" in\n  *--check-only*res://core/unit_test.gd*) [ -f addons/gut/gut_test.gd ] && grep -q GutTest addons/gut/gut_test.gd && exit 0; echo 'SCRIPT ERROR: Parse Error: Could not find base class "GutTest".'; echo '   at: GDScript::reload (res://core/unit_test.gd:1)'; exit 1;;\nesac\nexit 0`),
    );
    vi.mocked(requireEngine).mockResolvedValue(godot);
    const target = core({ ...FILES, 'client/godot/core/unit_test.gd': 'extends GutTest\n'});
    expect(await engineTypeCheck(ctx, target, ['godot'], workFolder())).toEqual([]);
    expect(installPackage).toHaveBeenCalledWith(ctx, expect.objectContaining({ name: 'gut', sha256: 'a'.repeat(64) }), expect.any(String));
    expect(readdirSync(join(target.root, 'client', 'godot', 'addons', 'gut'))).toEqual(['g.gd']);
  });

  it('fails a type rule warning: project.godot of the checked project sets the warnings to errors', async () => {
    // Fake Godot: an untyped declaration is an error only when project.godot sets untyped_declaration to 2.
    const godot = program(
      bin,
      'godot',
      `case "$*" in\n  *--check-only*res://core/untyped.gd*) if grep -q '^gdscript/warnings/untyped_declaration=2$' project.godot; then echo 'SCRIPT ERROR: Parse Error: Variable "x" has no static type. (UNTYPED_DECLARATION)'; echo '   at: GDScript::reload (res://core/untyped.gd:1)'; exit 1; fi; echo 'WARNING: Variable "x" has no static type.'; exit 0;;\nesac\nexit 0`,
    );
    vi.mocked(requireEngine).mockResolvedValue(godot);
    const settings = '[debug]\n\ngdscript/warnings/untyped_declaration=1\n';
    const target = core({ ...FILES, 'client/godot/project.godot': settings, 'client/godot/core/untyped.gd': 'var x = f()\n' });
    expect(await engineTypeCheck(ctx, target, ['godot'], workFolder())).toEqual([
      'client/godot/core/untyped.gd:1 Parse Error: Variable "x" has no static type. (UNTYPED_DECLARATION)',
    ]);
    expect(readFileSync(join(target.root, 'client', 'godot', 'project.godot'), 'utf8')).toBe(settings);
  });
});

describe('withErrorWarnings', () => {
  it('sets each type rule warning to 2 once, keeping the other settings', () => {
    const text = 'config_version=5\n\n[debug]\n\ngdscript/warnings/untyped_declaration=0\ngdscript/warnings/unused_variable=1\n\n[input]\n\nback={\n"deadzone": 0.5\n}\n';
    expect(withErrorWarnings(text)).toBe(
      `config_version=5\n\n[debug]\n\ngdscript/warnings/unused_variable=1\n\n[input]\n\nback={\n"deadzone": 0.5\n}\n\n[debug]\n\n${GDSCRIPT_ERROR_WARNINGS.map((name) => `gdscript/warnings/${name}=2`).join('\n')}\n`,
    );
    expect(GDSCRIPT_ERROR_WARNINGS).toEqual([
      'untyped_declaration', 'inference_on_variant', 'unsafe_property_access', 'unsafe_method_access', 'unsafe_cast', 'unsafe_call_argument',
    ]);
  });
});

describe('engineLint', () => {
  it('runs gdlint with only the name rules and reports violations at file:line', async () => {
    const gdlint = program(
      bin,
      'gdlint',
      `cat gdlintrc > ${log}\nfor f in "$@"; do echo "$f" >> ${log}.files; case "$f" in *Bad_name*) echo "$f:2: Error: Function name \\"Foo\\" is not valid (function-name)";; esac; done\nexit 1`,
    );
    vi.mocked(toolProgram).mockResolvedValue(gdlint);
    const target = core(FILES);
    expect(await engineLint(ctx, target, ['godot'])).toEqual(['client/godot/core/Bad_name.gd:2 Function name "Foo" is not valid (function-name)']);
    const disabled = readFileSync(log, 'utf8').split('\n').filter((l) => l.startsWith('  - ')).map((l) => l.slice(4));
    expect(disabled).toEqual([...GDLINT_OFF_RULES]);
    const nameRules = [
      'function-name', 'class-name', 'sub-class-name', 'signal-name', 'class-variable-name', 'class-load-variable-name',
      'function-variable-name', 'function-preload-variable-name', 'function-argument-name', 'loop-variable-name',
      'enum-name', 'enum-element-name', 'constant-name', 'load-constant-name',
    ];
    expect(disabled.filter((rule) => nameRules.includes(rule))).toEqual([]);
    expect(disabled).toHaveLength(16);
    expect(readFileSync(`${log}.files`, 'utf8')).not.toContain('addons');
  });

  it('fails without gdlint', async () => {
    vi.mocked(toolProgram).mockResolvedValue(null);
    await expect(engineLint(ctx, core(FILES), ['godot'])).rejects.toThrow('harness settings tools.gdtoolkit is not on this host');
  });
});
