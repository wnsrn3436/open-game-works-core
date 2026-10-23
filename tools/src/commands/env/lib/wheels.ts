import { OgwError } from '../../../lib/errors.ts';
import type { ToolDownload } from '../../../lib/settings.ts';
import type { HostPlatform } from './host.ts';
import { requestJson } from './net.ts';
import { compareHost, evaluateMarker, highestMatching, markerHostOf, parseRequirement, parseVersion, satisfies, type MarkerHost, type Version } from './pep440.ts';

/** Platforms a Python program pin carries wheels for. */
export const WHEEL_PLATFORMS: readonly HostPlatform[] = ['macos-arm64', 'linux-x64', 'windows-x64'];
/** The CPython minor version tried first, before any wheel names one. */
export const FIRST_PYTHON_MINOR = 14;

export interface PypiFile {
  filename: string;
  url: string;
  digests: { sha256: string };
  yanked?: boolean;
  /** The PEP 345 `Requires-Python` specifiers of the file, such as `>=3.10` or `>=3.8, <4`. */
  requires_python?: string | null;
}

export interface PypiProject {
  releases: Record<string, PypiFile[]>;
}

interface PypiRelease {
  info: { requires_dist?: string[] | null };
  urls: PypiFile[];
}

/** Reads PyPI JSON once per URL. */
export class Pypi {
  private readonly cache = new Map<string, Promise<unknown>>();

  private get<T>(url: string): Promise<T> {
    let hit = this.cache.get(url);
    if (hit === undefined) {
      hit = requestJson<T>(url);
      this.cache.set(url, hit);
    }
    return hit as Promise<T>;
  }

  private readonly projects = new Map<string, PypiProject>();

  async project(name: string): Promise<PypiProject> {
    const project = await this.get<PypiProject>(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
    this.projects.set(name, project);
    return project;
  }

  /** The project, or null when PyPI answers 404: it has no project of that name. */
  async projectIfExists(name: string): Promise<PypiProject | null> {
    try {
      return await this.project(name);
    } catch (error) {
      if (error instanceof OgwError && error.message === `GET https://pypi.org/pypi/${encodeURIComponent(name)}/json answered 404`) return null;
      throw error;
    }
  }

  /** CPython minor versions `3.<minor>` named by the `cp3<minor>` tags of the wheels of every project read so far. */
  cpythonMinors(): Set<number> {
    const minors = new Set<number>();
    for (const files of [...this.projects.values()].flatMap((p) => Object.values(p.releases))) {
      for (const tags of files.map((f) => wheelTags(f.filename))) {
        for (const tag of [...(tags?.python ?? []), ...(tags?.abi ?? [])]) {
          const m = /^cp3(\d+)$/.exec(tag);
          if (m) minors.add(Number(m[1]));
        }
      }
    }
    return minors;
  }

  release(name: string, version: string): Promise<PypiRelease> {
    return this.get(`https://pypi.org/pypi/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`);
  }
}

/** PEP 503 normalized name. */
export function normalizeName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, '-');
}

export interface WheelTags {
  python: string[];
  abi: string[];
  platform: string[];
}

/** Tags of a wheel file name `<name>-<version>(-<build>)?-<python>-<abi>-<platform>.whl`. */
export function wheelTags(filename: string): WheelTags | null {
  if (!filename.endsWith('.whl')) return null;
  const parts = filename.slice(0, -4).split('-');
  if (parts.length !== 5 && parts.length !== 6) return null;
  const [python, abi, platform] = parts.slice(-3) as [string, string, string];
  return { python: python.split('.'), abi: abi.split('.'), platform: platform.split('.') };
}

const PLATFORM_TAGS: Record<HostPlatform, RegExp> = {
  'macos-arm64': /^macosx_\d+_\d+_(arm64|universal2)$/,
  'linux-x64': /^manylinux(1|2010|2014|_\d+_\d+)_x86_64$/,
  'windows-x64': /^win_amd64$/,
};

/** A pure wheel for any platform and Python 3. */
export function isPureWheel(tags: WheelTags): boolean {
  return tags.platform.includes('any') && tags.abi.includes('none') && tags.python.some((p) => p === 'py3' || p.startsWith('py3'));
}

/** A wheel for the platform and CPython 3.<minor>. */
export function fitsPlatform(tags: WheelTags, platform: HostPlatform, minor: number): boolean {
  if (!tags.platform.some((p) => PLATFORM_TAGS[platform].test(p))) return false;
  if (tags.abi.includes(`cp3${String(minor)}`)) return true;
  const stable = tags.python.some((p) => /^cp3\d+$/.test(p) && Number(p.slice(3)) <= minor);
  return (tags.abi.includes('abi3') && stable) || (tags.abi.includes('none') && tags.python.some((p) => p === 'py3' || p === `cp3${String(minor)}`));
}

/** True when the file is not yanked and its `requires_python` allows CPython `3.<minor>`. */
export function usableFor(file: PypiFile, minor: number): boolean {
  if (file.yanked === true) return false;
  const specifiers = (file.requires_python ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');
  const python = parseVersion(`3.${String(minor)}`) as Version;
  return specifiers.every((s) => satisfies(python, s));
}

/** The wheel of a release for the platform and Python: a pure wheel first. */
export function pickWheel(files: readonly PypiFile[], platform: HostPlatform, minor: number): { file: PypiFile; pure: boolean } | null {
  const usable = files.filter((f) => usableFor(f, minor));
  const pure = usable.find((f) => {
    const tags = wheelTags(f.filename);
    return tags !== null && isPureWheel(tags);
  });
  if (pure) return { file: pure, pure: true };
  const fit = usable.find((f) => {
    const tags = wheelTags(f.filename);
    return tags !== null && fitsPlatform(tags, platform, minor);
  });
  return fit ? { file: fit, pure: false } : null;
}

/**
 * Evaluates a PEP 508 marker for a platform, a CPython minor version and the requested extras.
 * `extra`, `python_version` and the platform names are evaluated; any other comparison counts as true.
 */
export function markerFits(marker: string | null, host: MarkerHost, minor: number, extras: ReadonlySet<string>): boolean {
  if (marker === null) return true;
  return evaluateMarker(marker, (key, op, value) => {
    if (key === 'extra') return op === '==' ? extras.has(normalizeName(value)) : !extras.has(normalizeName(value));
    if ((key === 'python_version' || key === 'python_full_version') && !op.endsWith('in')) {
      return satisfies(parseVersion(`3.${String(minor)}`) as Version, `${op}${value}`);
    }
    return compareHost(host, key, op, value);
  });
}

export interface ResolvedWheel {
  name: string;
  version: string;
  file: PypiFile;
  pure: boolean;
}

interface Pending {
  name: string;
  version: string;
  extras: Set<string>;
}

/** The marker values of a host platform. */
export function hostOf(platform: HostPlatform): MarkerHost {
  const [os, arch] = { 'macos-arm64': ['darwin', 'arm64'], 'linux-x64': ['linux', 'x64'], 'windows-x64': ['win32', 'x64'] }[platform] as [string, string];
  return markerHostOf(os, arch);
}

/** The highest version satisfying the specifiers that has a wheel for the platform and Python. */
async function chooseVersion(pypi: Pypi, name: string, specifiers: string[], platform: HostPlatform, minor: number): Promise<{ version: string; wheel: { file: PypiFile; pure: boolean } }> {
  const project = await pypi.project(name);
  const candidates = Object.keys(project.releases);
  while (candidates.length > 0) {
    const version = highestMatching(candidates, specifiers);
    if (version === null) break;
    const wheel = pickWheel(project.releases[version] ?? [], platform, minor);
    if (wheel) return { version, wheel };
    candidates.splice(candidates.indexOf(version), 1);
  }
  throw new OgwError(`no wheel of ${name} ${specifiers.join(',')} for ${platform} CPython 3.${String(minor)}`);
}

/** Every wheel the root release needs on a platform and CPython 3.<minor>, the root first. */
export async function resolveWheels(pypi: Pypi, root: { name: string; version: string }, platform: HostPlatform, minor: number): Promise<ResolvedWheel[]> {
  const host = hostOf(platform);
  const rootWheel = pickWheel((await pypi.project(root.name)).releases[root.version] ?? [], platform, minor);
  if (!rootWheel) throw new OgwError(`no wheel of ${root.name} ${root.version} for ${platform} CPython 3.${String(minor)}`);
  const resolved = new Map<string, ResolvedWheel>([[normalizeName(root.name), { name: root.name, version: root.version, ...rootWheel }]]);
  const queue: Pending[] = [{ name: root.name, version: root.version, extras: new Set() }];
  for (let item = queue.shift(); item !== undefined; item = queue.shift()) {
    for (const text of (await pypi.release(item.name, item.version)).info.requires_dist ?? []) {
      const requirement = parseRequirement(text);
      if (!requirement) throw new OgwError(`cannot read dependency of ${item.name}: ${text}`);
      if (!markerFits(requirement.marker, host, minor, item.extras)) continue;
      const key = normalizeName(requirement.name);
      const extras = new Set(requirement.extras.replace(/[[\]]/g, '').split(',').filter((e) => e !== '').map(normalizeName));
      const known = resolved.get(key);
      if (known) {
        const version = parseVersion(known.version);
        if (version === null || !requirement.specifiers.every((s) => satisfies(version, s))) {
          throw new OgwError(`${requirement.name} ${known.version} does not satisfy ${text} of ${item.name}`);
        }
        if (extras.size > 0) queue.push({ name: known.name, version: known.version, extras });
        continue;
      }
      const chosen = await chooseVersion(pypi, requirement.name, requirement.specifiers, platform, minor);
      resolved.set(key, { name: requirement.name, version: chosen.version, ...chosen.wheel });
      queue.push({ name: requirement.name, version: chosen.version, extras });
    }
  }
  return [...resolved.values()];
}

/** `downloads` and `dependencies` of a Python program pin from the wheels resolved per platform. */
export function pinEntries(perPlatform: ReadonlyMap<HostPlatform, ResolvedWheel[]>): { downloads: ToolDownload[]; dependencies: ToolDownload[] } {
  const entries = new Map<string, ToolDownload>();
  let downloads: ToolDownload[] = [];
  for (const [platform, wheels] of perPlatform) {
    wheels.forEach((wheel, index) => {
      const entry: ToolDownload = { platform: wheel.pure ? 'any' : platform, url: wheel.file.url, sha256: wheel.file.digests.sha256 };
      if (index === 0) downloads = [entry];
      else entries.set(`${entry.platform} ${entry.url}`, entry);
    });
  }
  const dependencies = [...entries.values()].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
  return { downloads, dependencies };
}
