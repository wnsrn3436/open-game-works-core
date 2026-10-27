import { isDeepStrictEqual } from 'node:util';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { exists, readJsonIfExists } from '../../../lib/fsx.ts';
import { revParse } from '../../../lib/git.ts';
import { byteCompare } from '../../../lib/order.ts';
import { runCodeCheck } from '../../code/api.ts';
import { changedSinceDone, lastReviewResults } from '../../review/api.ts';
import { readAllLists } from '../../review/lib/debt.ts';
import { reviewTargetsSince } from '../dependents.ts';
import { buildCoreSpec } from '../spec-api.ts';
import {
  corePlugins,
  enginesOf,
  readCoreSettings,
  readCoreSpecDir,
  pluginDistDir,
  readEngineJson,
  workingFiles,
  type CoreSpecModule,
  type SettingsConstraint,
} from './impl.ts';
import { mergedRecords, SCREEN_LOCKED_SKIP } from './test-records.ts';
import { baseProtoBreaks } from './base-proto-compat.ts';
import { implementedTools } from './tools.ts';
import { engineAssetRules } from './undefined.ts';
import { compareVersions, majorOf, releaseTag } from './version.ts';

/**
 * Targets that have an implementation and the modules each must pass for a release: `server` when
 * `server/core/` exists, each engine with `client/<engine>/engine.json`, and `tools` with each tool that has
 * `tools/<tool>/package.json`.
 */
export async function requiredTargets(implDir: string, modules: readonly CoreSpecModule[]): Promise<Map<string, string[]>> {
  const client = modules.filter((m) => m.side === 'client').map((m) => m.name);
  const targets = new Map<string, string[]>();
  if (exists(join(implDir, 'server', 'core'))) targets.set('server', modules.filter((m) => m.side === 'server').map((m) => m.name));
  for (const engine of await enginesOf(implDir)) {
    targets.set(engine, client);
    targets.set(`${engine} --web`, client);
  }
  const tools = implementedTools(implDir);
  if (tools.length > 0) targets.set('tools', tools);
  return targets;
}

/**
 * Modules a release does not wait for and reports: `skipped` only for a render pass that a locked macOS screen kept
 * from running (`SCREEN_LOCKED_SKIP`), as `core test <target>: <module>: <reason>` lines.
 */
export async function untestedRenderPasses(implDir: string, commit: string, modules: readonly CoreSpecModule[]): Promise<string[]> {
  return (await testRecordFindings(implDir, commit, modules)).untested;
}

export async function testRecordViolations(implDir: string, commit: string, modules: readonly CoreSpecModule[]): Promise<string[]> {
  return (await testRecordFindings(implDir, commit, modules)).violations;
}

async function testRecordFindings(implDir: string, commit: string, modules: readonly CoreSpecModule[]): Promise<{ violations: string[]; untested: string[] }> {
  const merged = await mergedRecords(implDir, commit);
  const violations: string[] = [];
  const untested: string[] = [];
  for (const [target, names] of await requiredTargets(implDir, modules)) {
    const results = merged.get(target);
    for (const name of names) {
      const entry = results?.get(name);
      if (entry?.result === 'skipped' && entry.skip === SCREEN_LOCKED_SKIP) untested.push(`core test ${target}: ${name}: ${entry.skip}`);
      else if (entry?.result !== 'pass') violations.push(`core test ${target}: ${name} is ${entry?.result ?? 'not recorded'} at ${commit}`);
    }
  }
  return { violations, untested };
}

export async function coreSpecViolations(ctx: Context, implDir: string): Promise<string[]> {
  const build = await buildCoreSpec(ctx);
  const violations = build.errors.map((error) => `core spec: ${error}`);
  const dir = join(implDir, 'core-spec');
  for (const [name, module] of build.modules) {
    const file = join(dir, `${name}.json`);
    const current = await readJsonIfExists(file).catch(() => undefined);
    if (current === null) violations.push(`core-spec/${name}.json is missing`);
    else if (!isDeepStrictEqual(current, module)) violations.push(`core-spec/${name}.json differs from ogw core spec`);
  }
  // `ogw core spec` removes every file that is not a module file, whatever its extension.
  const entries = exists(dir) ? await readdir(dir, { withFileTypes: true }) : [];
  for (const file of entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name).sort()) {
    if (!(file.endsWith('.json') && build.modules.has(file.slice(0, -'.json'.length)))) {
      violations.push(`core-spec/${file} is not a module`);
    }
  }
  return violations;
}

/** The highest of `released` below `version`, or undefined. */
function lowerRelease(version: string, released: readonly string[]): string | undefined {
  return released.filter((v) => compareVersions(v, version) < 0).sort(compareVersions).at(-1);
}

/**
 * The review conditions (`core` command.md `## version and release`): each target with review state has a judged
 * `done` last round and did not change since it started, and each review target of the changes since the tag of the
 * highest release below `version` (`ogw core review-targets`) has review state.
 */
export async function reviewViolations(
  ctx: Context,
  implDir: string,
  commit: string,
  modules: readonly CoreSpecModule[],
  version: string,
  released: readonly string[],
): Promise<string[]> {
  const violations: string[] = [];
  const results = await lastReviewResults(ctx, 'core');
  for (const [target, result] of results) {
    if (result !== 'done') violations.push(`review ${target}: last round result is ${result ?? 'none'}`);
  }
  for (const [target, round] of await changedSinceDone(ctx, 'core')) {
    violations.push(`review ${target}: changed since its done round ${String(round)}; run ogw review run core ${target} --reopen`);
  }
  const lower = lowerRelease(version, released);
  if (lower === undefined) return violations;
  const tag = releaseTag(lower);
  if ((await revParse(implDir, tag, { env: ctx.env })) === null) {
    return [...violations, `review targets since ${tag}: tag ${tag} is not in open-game-works-core-impl/`];
  }
  const found = await reviewTargetsSince(ctx, implDir, new Map(modules.map((m) => [m.name, m])), tag, commit);
  for (const target of [...found.modules, ...found.tools].sort(byteCompare)) {
    if (!results.has(target)) violations.push(`review ${target}: changed since ${tag} and has no review state; run ogw review run core ${target} --since ${tag}`);
  }
  return violations;
}

/** The items of the must-fix lists of `implDir` (`core` command.md `## review lists`): each refuses the release. */
export async function reviewDebtViolations(implDir: string): Promise<string[]> {
  return (await readAllLists(implDir, 'must fix')).flatMap((list) => list.items
    .map((item) => `review must fix ${list.target}: ${item.id} ${item.severity ?? 'high'} ${item.location}: ${item.problem}`));
}

/** The release output line of each debt list of `implDir` with items: `review debt <target>: <n>`. */
export async function reviewDebtCounts(implDir: string): Promise<string[]> {
  return (await readAllLists(implDir, 'debt')).filter((list) => list.items.length > 0).map((list) => `review debt ${list.target}: ${String(list.items.length)}`);
}

/** `ogw code check core` on `implDir`, the checkout the release is made from, wherever the command runs. */
export async function codeCheckViolations(ctx: Context, implDir: string): Promise<string[]> {
  const items = await runCodeCheck(ctx, 'core', implDir);
  return items
    .filter((item) => item.result !== 'pass')
    .map((item) => `ogw code check core: ${item.name} fail${item.failures.length > 0 ? `\n  ${item.failures.join('\n  ')}` : ''}`);
}

/**
 * Settings constraints whose two keys belong to modules of a side with an implementation: `server` when
 * `server/core/` exists, `client` when an engine has `client/<engine>/engine.json`. A key is `<module>.<name>`;
 * a key of no known module is kept, so its missing value is reported.
 */
export async function implementedConstraints(implDir: string, modules: readonly CoreSpecModule[]): Promise<SettingsConstraint[]> {
  const sides = new Set<string>();
  if (exists(join(implDir, 'server', 'core'))) sides.add('server');
  if ((await enginesOf(implDir)).length > 0) sides.add('client');
  const sideOf = new Map(modules.map((m) => [m.name, m.side]));
  const implemented = (key: string): boolean => {
    const side = sideOf.get(key.slice(0, key.indexOf('.')));
    return side === undefined || sides.has(side);
  };
  return modules.flatMap((m) => m.settingsConstraints).filter((c) => implemented(c.left) && implemented(c.right));
}

export function constraintViolations(settings: Record<string, unknown> | null, constraints: readonly SettingsConstraint[]): string[] {
  const violations: string[] = [];
  for (const { left, factor, right } of constraints) {
    const l = settings?.[left];
    const r = settings?.[right];
    if (typeof l !== 'number' || typeof r !== 'number') {
      violations.push(`settings constraint ${left} × ${String(factor)} ≤ ${right}: a value is missing or not a number`);
    } else if (l * factor > r) {
      violations.push(`settings constraint ${left} × ${String(factor)} ≤ ${right}: ${String(l)} × ${String(factor)} > ${String(r)}`);
    }
  }
  return violations;
}

export async function pluginBuildViolations(implDir: string): Promise<string[]> {
  const violations: string[] = [];
  for (const engine of await enginesOf(implDir)) {
    const plugins = corePlugins(await readEngineJson(implDir, engine));
    if (plugins.length > 0 && engine !== 'godot') engineAssetRules(engine);
    for (const plugin of plugins) {
      const platforms = plugin.platforms ?? [];
      if (platforms.length === 0) violations.push(`plugin ${plugin.name} of ${engine}: no target platforms in engine.json`);
      for (const platform of platforms) {
        const dist = pluginDistDir(engine, plugin.name, platform);
        if ((await workingFiles(implDir, dist)).length === 0) violations.push(`plugin ${plugin.name} of ${engine}: no build result in ${dist}`);
      }
    }
  }
  return violations;
}

export async function baseProtoViolations(ctx: Context, implDir: string, version: string, released: readonly string[]): Promise<string[]> {
  const lower = lowerRelease(version, released);
  if (lower === undefined) return [];
  const breaks = await baseProtoBreaks(ctx, implDir, lower);
  if (breaks.length === 0 || majorOf(version) > majorOf(lower)) return [];
  return [`base proto breaks backward compatibility with ${lower} but the major version is not higher:\n  ${breaks.join('\n  ')}`];
}

/** Every release condition `ogw core release` checks (`core` command.md `## version and release`). */
export async function releaseViolations(
  ctx: Context,
  implDir: string,
  commit: string,
  version: string,
  released: readonly string[],
): Promise<string[]> {
  // a file that is not a module is reported by the core-spec condition; the other conditions use the readable ones
  const modules = await readCoreSpecDir(implDir, { skipInvalid: true });
  return [
    ...(await testRecordViolations(implDir, commit, modules)),
    ...(await coreSpecViolations(ctx, implDir)),
    ...(await reviewViolations(ctx, implDir, commit, modules, version, released)),
    ...(await reviewDebtViolations(implDir)),
    ...(await codeCheckViolations(ctx, implDir)),
    ...constraintViolations(await readCoreSettings(implDir), await implementedConstraints(implDir, modules)),
    ...(await pluginBuildViolations(implDir)),
    ...(await baseProtoViolations(ctx, implDir, version, released)),
  ];
}
