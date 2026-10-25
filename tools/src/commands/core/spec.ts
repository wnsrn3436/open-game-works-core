import { expectPositionals, type CommandDef, type CommandResult } from '../../lib/command.ts';
import { resolveCoreImpl } from '../../lib/game.ts';
import { SETTING_TYPES_FILE, withGeneratedCommit } from './lib/main-checkout.ts';
import { writeCoreSpec } from './spec-api.ts';

function failure(errors: string[]): CommandResult {
  return { exitCode: 1, text: errors.join('\n'), data: { ok: false, errors } };
}

export const spec: CommandDef = {
  name: ['core', 'spec'],
  usage: 'ogw core spec',
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const coreImpl = (await ctx.workspace()).coreImpl;
    const implDir = await resolveCoreImpl(await ctx.workspace(), ctx.cwd, ctx.env);
    const result = await withGeneratedCommit(implDir, coreImpl, ctx.env, () => writeCoreSpec(ctx));
    if (result.errors.length > 0) return failure(result.errors);
    const lines = [
      ...result.written.map((file) => `wrote core-spec/${file}`),
      ...result.deleted.map((file) => `deleted core-spec/${file}`),
      ...(result.settingTypesWritten ? [`wrote ${SETTING_TYPES_FILE}`] : []),
    ];
    return {
      text: lines.length > 0 ? lines.join('\n') : 'core-spec and the settings type table are up to date',
      data: { ok: true, dir: result.dir, modules: result.modules.size, written: result.written, deleted: result.deleted, settingTypesWritten: result.settingTypesWritten, errors: [] },
    };
  },
};
