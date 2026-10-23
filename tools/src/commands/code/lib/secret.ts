import type { Context } from '../../../lib/command.ts';
import { scanFiles, type Needle } from '../../../lib/secret-scan.ts';
import { harnessSecretService } from '../../../lib/secrets.ts';
import { harnessSecretNames } from '../../secret/lib/names.ts';
import type { CheckTarget } from './target.ts';

/** Values the secret check looks for: the workspace path and the harness settings secrets in this host's secret store. */
export async function secretNeedles(ctx: Context): Promise<Needle[]> {
  const settings = await ctx.settings();
  const needles: Needle[] = [{ label: 'workspace path', value: Buffer.from((await ctx.workspace()).root) }];
  const names = new Set(harnessSecretNames(settings));
  for (const name of names) {
    // A store failure fails the check, as in the build-time check; only a missing entry means no value.
    const value = ctx.secrets.get(harnessSecretService(name));
    if (value !== null && value !== '') needles.push({ label: `secret ${name}`, value: Buffer.from(value) });
  }
  return needles;
}

/** Build-time check `secret` on the target code: no secret and no workspace absolute path in its files. */
export async function secretCheck(target: CheckTarget, needles: readonly Needle[]): Promise<string[]> {
  return scanFiles(target.root, target.files, needles, { lines: true });
}
