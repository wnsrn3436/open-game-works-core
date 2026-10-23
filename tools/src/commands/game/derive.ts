import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { writeChecked } from '../settings/lib/change.ts';
import { changedPaths, display } from '../settings/lib/json-path.ts';
import { withGameTarget } from '../settings/lib/target.ts';
import { deriveSettings } from './lib/derive.ts';

export const derive: CommandDef = {
  name: ['game', 'derive'],
  usage: 'ogw game derive <game>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const changed = await withGameTarget(ctx, positional(args, 0, 'game'), async (target) => {
      const next = deriveSettings(target.value);
      const paths = changedPaths(target.value, next).map(display);
      if (paths.length > 0) await writeChecked(ctx, target, next);
      return paths;
    });
    return {
      text: changed.length > 0 ? changed.map((path) => `set ${path}`).join('\n') : 'no change',
      data: { changed },
    };
  },
};
