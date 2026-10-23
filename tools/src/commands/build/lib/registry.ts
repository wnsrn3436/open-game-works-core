import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';
import { run, runOk } from '../../../lib/proc.ts';

const REGISTRY = 'ghcr.io';

/** Logs Docker in to `ghcr.io` with the GitHub CLI login of this host. */
export async function ghcrLogin(ctx: Context): Promise<void> {
  const token = (await runOk('gh', ['auth', 'token'], { env: ctx.env, timeoutMs: LIMITS.shortMs })).stdout.trim();
  const user = (await runOk('gh', ['api', 'user', '--jq', '.login'], { env: ctx.env, timeoutMs: LIMITS.shortMs })).stdout.trim();
  if (token === '' || user === '') throw new OgwError('the GitHub CLI is not logged in');
  await runOk('docker', ['login', REGISTRY, '--username', user, '--password-stdin'], {
    env: ctx.env,
    input: `${token}\n`,
    timeoutMs: LIMITS.shortMs,
  });
}

async function inspect(ctx: Context, ref: string, format: string): Promise<unknown> {
  const result = await run('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', format], {
    env: ctx.env,
    timeoutMs: LIMITS.programMs,
  });
  if (result.timedOut) throw new OgwError(`docker buildx imagetools inspect ${ref} timed out`);
  if (result.code !== 0) return null;
  return JSON.parse(result.stdout) as unknown;
}

/** Digest of an image in the registry, or null when the image is not there. */
export async function imageDigest(ctx: Context, ref: string): Promise<string | null> {
  const manifest = (await inspect(ctx, ref, '{{json .Manifest}}')) as { digest?: string } | null;
  return manifest?.digest ?? null;
}

type ImageConfig = { config?: { Labels?: Record<string, string> | null } };

/** A label of the image config; null when the image or the label is not there. */
export async function imageLabel(ctx: Context, ref: string, label: string): Promise<string | null> {
  const image = (await inspect(ctx, ref, '{{json .Image}}')) as ImageConfig | Record<string, ImageConfig> | null;
  if (image === null) return null;
  const config = 'config' in image ? (image as ImageConfig) : Object.values(image as Record<string, ImageConfig>)[0];
  return config?.config?.Labels?.[label] ?? null;
}
