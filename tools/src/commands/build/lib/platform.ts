import type { Context } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { GameRepo } from '../../../lib/game.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import type { Env } from './names.ts';
import type { StoreAnswer } from './privacy.ts';

export interface PlatformBuildInput {
  game: GameRepo;
  env: Env;
  /** `<version>` or `<app version>-bundle-<n>`. */
  version: string;
  platforms: string[];
  settings: GameSettings;
  /** `builds/<env>-<version>/`. */
  outDir: string;
  /** iOS privacy manifest answers (`NSPrivacyCollectedDataTypes`). */
  iosPrivacy: StoreAnswer[];
  /** `builds/<env>-<version>/privacy/PrivacyInfo.xcprivacy` when written. */
  privacyManifest: string | null;
}

export interface Artifact {
  platform: string;
  /** Game-repo relative path of the artifact folder. */
  path: string;
  /** DEV build: the free signing method (`build` `## platform build`) the artifact was made with. */
  freeSigning?: string;
}

/** One platform build: its artifact folder and the `DEV code` check failures of its package. */
export interface PlatformBuild {
  artifact: Artifact;
  devCode: string[];
}

/** Platform builds of the engine, in parallel; one artifact folder per platform. */
export async function buildPlatforms(ctx: Context, input: PlatformBuildInput): Promise<{ artifacts: Artifact[]; devCode: string[] }> {
  const engine = input.settings.engine ?? 'godot';
  if (engine !== 'godot') throw new OgwError(`not defined: platform build of engine ${engine}`);
  const { godotBuild } = await import('./godot.ts');
  const builds = await Promise.all(input.platforms.map((platform) => godotBuild(ctx, input, platform)));
  return { artifacts: builds.map((b) => b.artifact), devCode: builds.flatMap((b) => b.devCode) };
}

export interface BundleBuildInput {
  game: GameRepo;
  env: Env;
  version: string;
  appVersion: string;
  settings: GameSettings;
  outDir: string;
  /** True when the bundle carries data. */
  withData: boolean;
}

/** Bundle patch export: `builds/<env>-<version>/patch/` (`build` `## bundle patch`). Returns the bundle check failures. */
export async function buildBundle(ctx: Context, input: BundleBuildInput): Promise<string[]> {
  const engine = input.settings.engine ?? 'godot';
  if (engine !== 'godot') throw new OgwError(`not defined: bundle export of engine ${engine}`);
  const { godotBundle } = await import('./godot-bundle.ts');
  return godotBundle(ctx, input);
}
