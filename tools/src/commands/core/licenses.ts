import { join } from 'node:path';
import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists, formatJson, readJson, writeIfChanged } from '../../lib/fsx.ts';
import { coreImplOf } from './lib/impl.ts';
import { requiredTextIds, spdxLicenseTexts, textIds, type LicenseTexts } from './lib/spec-licenses.ts';

interface Manifest {
  components: { name: string; license: string }[];
  [key: string]: unknown;
}

function asManifest(value: unknown, path: string): Manifest {
  const m = value as { components?: unknown } | null;
  const components = m !== null && typeof m === 'object' ? m.components : undefined;
  const ok =
    Array.isArray(components) &&
    components.every((c: unknown) => {
      const comp = c as { name?: unknown; license?: unknown } | null;
      return comp !== null && typeof comp === 'object' && typeof comp.name === 'string' && typeof comp.license === 'string';
    });
  if (!ok) throw new OgwError(`${path}: "components" must be a list of objects with string "name" and "license"`);
  return value as Manifest;
}

/** IDs not in the license list, each with the components that use it. License references are not IDs of the list. */
function unknownIds(manifest: Manifest, texts: LicenseTexts): Map<string, string[]> {
  const unknown = new Map<string, string[]>();
  for (const component of manifest.components) {
    for (const id of textIds(component.license)) {
      if (texts.has(id)) continue;
      const users = unknown.get(id) ?? [];
      if (!users.includes(component.name)) users.push(component.name);
      unknown.set(id, users);
    }
  }
  return unknown;
}

export const licenses: CommandDef = {
  name: ['core', 'licenses'],
  usage: 'ogw core licenses',
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const path = join(await coreImplOf(ctx), 'licenses.json');
    if (!exists(path)) throw new OgwError(`file not found: ${path}`);
    const manifest = asManifest(await readJson(path), path);
    const texts = spdxLicenseTexts();
    const unknown = unknownIds(manifest, texts);
    if (unknown.size > 0) {
      const lines = [...unknown].map(([id, users]) => `${id}: not in the SPDX license list or exception list; used by ${users.join(', ')}`);
      return { exitCode: 1, text: lines.join('\n'), data: { unknown: Object.fromEntries(unknown) } };
    }
    const ws = await ctx.workspace();
    const sorted = await requiredTextIds(manifest.components.map((c) => c.license), ws.harness);
    const next = { ...manifest, texts: Object.fromEntries(sorted.map((id) => [id, texts.get(id) as string])) };
    const written = await writeIfChanged(path, formatJson(next));
    return {
      text: `${written ? 'wrote' : 'unchanged'} ${path}: ${String(sorted.length)} license texts (${sorted.join(', ')})`,
      data: { path, written, ids: sorted },
    };
  },
};
