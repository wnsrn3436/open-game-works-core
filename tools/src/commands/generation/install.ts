import { expectPositionals, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { LIMITS } from '../../lib/limits.ts';
import { withLock } from '../../lib/lock.ts';
import type { HarnessSettings } from '../../lib/settings.ts';
import { envResultPath } from '../env/lib/host.ts';
import { readEnvResult, writeEnvResult, type GenerationInstallResult, type InstallEntry } from '../env/lib/results.ts';
import { installTool, postgresPresent, pullPostgres, TOOL_NAMES } from '../env/lib/tools.ts';
import { hasPins, installMethod, missingPinSecret, missingSecret } from './lib/install.ts';

async function installMethods(ctx: Context, settings: HarnessSettings, only: string | null): Promise<GenerationInstallResult['methods']> {
  const methods: GenerationInstallResult['methods'] = {};
  for (const method of settings.resourceGeneration) {
    if (only !== null && method.name !== only) continue;
    const methodSecret = missingSecret(ctx, method);
    const entry: InstallEntry = hasPins(method)
      ? await installMethod(ctx, method)
      : { installed: methodSecret === null, reason: methodSecret === null ? null : `secret ${methodSecret} is not in the host secret store`, mismatches: [] };
    const secret = methodSecret ?? (entry.installed ? null : (missingPinSecret(ctx, method)?.secret ?? null));
    methods[method.name] = { kind: method.kind, ...entry, ...(secret === null ? {} : { secretMissing: secret }) };
    // a long install job shows each result as it comes, not only at the end
    ctx.log(line('method', method.name, entry));
  }
  return methods;
}

async function installTools(ctx: Context, settings: HarnessSettings): Promise<GenerationInstallResult['tools']> {
  const tools: GenerationInstallResult['tools'] = {};
  for (const name of TOOL_NAMES) {
    const pin = settings.tools[name];
    if (pin === undefined) continue;
    tools[name] = await installTool(ctx, name, pin);
    ctx.log(line('tool', name, tools[name]));
  }
  const postgres = settings.tools.postgresql;
  tools.postgresql = (await postgresPresent(ctx, postgres)) ? { installed: true, reason: null, mismatches: [] } : await pullPostgres(ctx, postgres);
  return tools;
}

function line(kind: string, name: string, entry: InstallEntry): string {
  const state = entry.installed ? 'installed' : `failed: ${entry.reason ?? 'failed'}`;
  const differs = entry.mismatches.map((m) => `\n  differs: ${m.what} ${m.path} expected ${m.expected} actual ${m.actual}`).join('');
  return `${kind} ${name}: ${state}${differs}`;
}

export const installCommand: CommandDef = {
  name: ['generation', 'install'],
  usage: 'ogw generation install [<method>]',
  background: { timeLimitMs: () => LIMITS.jobMs },
  async run(ctx, args) {
    expectPositionals(args, 0, 1, this.usage);
    const settings = await ctx.settings();
    const only = args.positionals[0] ?? null;
    if (only !== null && !settings.resourceGeneration.some((m) => m.name === only)) {
      throw new OgwError(`no method ${only} in harness settings resourceGeneration`);
    }
    // Tools first: a provider method's executable puts tools.ffmpeg on its PATH.
    const installedTools = only === null ? await installTools(ctx, settings) : null;
    const methods = await installMethods(ctx, settings, only);
    // Another install job may write the result file meanwhile: read, merge and write it under one lock.
    const { result, path } = await withLock(`${await envResultPath(ctx.env, 'generation-install')}.lock`, async () => {
      const previous = only === null ? null : await readEnvResult(ctx, 'generation-install');
      const merged: GenerationInstallResult = { installedAt: Date.now(), methods: { ...(previous?.methods ?? {}), ...methods }, tools: installedTools ?? previous?.tools ?? {} };
      return { result: merged, path: await writeEnvResult(ctx, 'generation-install', merged) };
    });
    const lines = [
      ...Object.entries(methods).map(([name, entry]) => line('method', name, entry)),
      ...(only === null ? Object.entries(result.tools).map(([name, entry]) => line('tools', name, entry)) : []),
      ...Object.values(methods)
        .filter((m) => m.secretMissing !== undefined)
        .map((m) => `put the secret in the host secret store: ogw secret set --harness ${String(m.secretMissing)}`),
      `result: ${path}`,
    ];
    const failed = [...Object.values(methods), ...(only === null ? Object.values(result.tools) : [])].some((e) => !e.installed);
    return { exitCode: failed ? 1 : 0, text: lines.join('\n'), data: { ...result, resultFile: path } };
  },
};
