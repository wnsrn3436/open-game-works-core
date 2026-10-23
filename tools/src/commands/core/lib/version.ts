import { OgwError } from '../../../lib/errors.ts';

/** A core version `<major>.<minor>.<patch>`. */
export const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

/** The release tag of a core version (`core` command.md `## version and release`). */
export const RELEASE_TAG = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;

export function isVersion(value: string): boolean {
  return VERSION.test(value);
}

export function requireVersion(value: string, what = 'core version'): string {
  if (!isVersion(value)) throw new OgwError(`invalid ${what}: ${value} (expected <major>.<minor>.<patch>)`);
  return value;
}

export function versionParts(version: string): [number, number, number] {
  const match = VERSION.exec(version);
  if (!match) throw new OgwError(`invalid core version: ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Negative when `a` is lower than `b`, 0 when equal, positive when higher. */
export function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < 3; i++) {
    const diff = (pa[i] as number) - (pb[i] as number);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function majorOf(version: string): number {
  return versionParts(version)[0];
}

export function releaseTag(version: string): string {
  return `v${version}`;
}

/** Versions in ascending order without duplicates. */
export function sortVersions(versions: Iterable<string>): string[] {
  return [...new Set(versions)].sort(compareVersions);
}
