import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { loadSchema, schemaPath, withDefaults } from '../../../lib/settings.ts';
import { coreFiles } from '../../settings/lib/core-files.ts';
import { addedLeaves, display, isPlainObject, type JsonObject } from '../../settings/lib/json-path.ts';

export interface DefaultValue {
  path: string;
  value: unknown;
  /** `schema default` (game settings schema) or `core settings` (core release `core-settings.json`). */
  source: 'schema default' | 'core settings';
}

/** Values the game uses without writing them: game settings schema defaults and core settings defaults (`game-setup` 10). */
export async function defaultValues(ctx: Context, settings: JsonObject): Promise<DefaultValue[]> {
  if (typeof settings.coreVersion !== 'string') throw new OgwError('game settings have no coreVersion');
  const schema = await loadSchema(schemaPath('game-settings', ctx.env));
  const out: DefaultValue[] = addedLeaves(settings, withDefaults(schema, settings)).map(({ path, value }) => ({
    path: display(path),
    value,
    source: 'schema default',
  }));
  const core = await coreFiles(ctx, settings.coreVersion);
  const written = isPlainObject(settings.core) ? settings.core : {};
  for (const [key, value] of Object.entries(core.settings)) {
    for (const leaf of addedLeaves(written[key], value, ['core', key])) {
      out.push({ path: display(leaf.path), value: leaf.value, source: 'core settings' });
    }
  }
  return out;
}

export function defaultsText(values: readonly DefaultValue[]): string {
  return values.map((v) => `${v.path} = ${JSON.stringify(v.value)} (${v.source})`).join('\n');
}
