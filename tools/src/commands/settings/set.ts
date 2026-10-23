import type { CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { writeChecked } from './lib/change.ts';
import { display, setAt } from './lib/json-path.ts';
import { containerKinds, parsePath, withTarget, withValue } from './lib/target.ts';

function parseValue(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new OgwError(`not a JSON value: ${text}`);
  }
}

export const set: CommandDef = {
  name: ['settings', 'set'],
  usage: 'ogw settings set <harness|game <game>|core> <path> <JSON value> [<path> <JSON value>]...',
  async run(ctx, args) {
    const usage = this.usage;
    return withTarget(ctx, args.positionals, usage, async ({ target, rest }) => {
      if (rest.length < 2 || rest.length % 2 !== 0) throw new OgwError(`usage: ${usage}`);
      // every pair goes into one result, which is checked once (AGENTS.md `## settings`)
      const pairs: [string, unknown][] = [];
      for (let i = 0; i < rest.length; i += 2) pairs.push([rest[i] as string, parseValue(rest[i + 1] as string)]);
      // a `core.` key of game settings is read by the `coreVersion` of the result: the other pairs go in first
      const isCoreKey = ([path]: [string, unknown]): boolean => target.kind === 'game' && path.startsWith('core.');
      let next = target.value;
      const written: { path: string; value: unknown }[] = [];
      for (const [path, value] of [...pairs.filter((p) => !isCoreKey(p)), ...pairs.filter(isCoreKey)]) {
        const current = withValue(ctx, target, next);
        const segments = await parsePath(current, path, { create: true });
        next = setAt(next, segments, value, await containerKinds(current, segments));
        written.push({ path: display(segments), value });
      }
      await writeChecked(ctx, target, next);
      const first = written[0] as { path: string; value: unknown };
      return {
        text: written.map((w) => `set ${w.path}`).join('\n'),
        data: written.length === 1 ? first : { set: written },
      };
    });
  },
};
