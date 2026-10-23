import { join } from 'node:path';
import type { Context } from '../../../lib/command.ts';
import { extractedAsset, publishedRelease } from '../api.ts';
import { compareBaseProto } from './tools.ts';

/** Breaking changes between the base proto of release `previousVersion` and the base proto of `open-game-works-core-impl/`. */
export async function baseProtoBreaks(ctx: Context, implDir: string, previousVersion: string): Promise<string[]> {
  const release = await publishedRelease(ctx, previousVersion);
  const tool = await extractedAsset(ctx, release, 'contract-tool.tgz');
  return compareBaseProto(ctx, implDir, { proto: join(tool, 'proto'), coreSettings: join(release.dir, 'core-settings.json') });
}
