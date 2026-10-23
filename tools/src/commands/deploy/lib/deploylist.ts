import { compareVersions, parseVersion } from '../../build/lib/names.ts';

export interface FileEntry {
  name: string;
  size: number;
  sha256: string;
}

export interface PatchEntry {
  data_version: string;
  data_files: FileEntry[];
  translation_files: (FileEntry & { language: string })[];
  bundle_files: (FileEntry & { bundle: string })[];
}

export interface AppEntry {
  min_version: string;
  recommended_version: string;
  store_url: string;
}

export interface DeployList {
  app: Record<string, AppEntry>;
  patches: Record<string, PatchEntry>;
}

/** `builds/<env>-<version>/update/update.json`. */
export interface UpdateJson {
  data_version: string;
  data_files: FileEntry[];
  translation_files: (FileEntry & { language: string })[];
  apps: string[];
}

export interface DeployListInput {
  /** Deploy list read before the deploy; null when there was none. */
  read: DeployList | null;
  /** True when step 1 removed the DB volume: the read `patches` count as empty. */
  dbWiped: boolean;
  update: UpdateJson | null;
  /** `patch/patch.json` and its app version, when the build has one. */
  patch: { appVersion: string; entry: PatchEntry } | null;
  /** `compat_client_data_version` of the new server; null when the build has no server image and the server stays. */
  compat: string | null;
}

function lowestMinVersion(app: Record<string, AppEntry>): string | null {
  let lowest: string | null = null;
  for (const entry of Object.values(app)) {
    const v = parseVersion(entry.min_version);
    const best = lowest === null ? null : parseVersion(lowest);
    if (v && (best === null || compareVersions(v, best) < 0)) lowest = entry.min_version;
  }
  return lowest;
}

function atLeast(version: string, min: string | null): boolean {
  if (min === null) return true;
  const v = parseVersion(version);
  const m = parseVersion(min);
  return v !== null && m !== null && compareVersions(v, m) >= 0;
}

function updateEntries(input: DeployListInput, readPatches: Record<string, PatchEntry>, min: string | null): Record<string, PatchEntry> {
  const update = input.update;
  const patches: Record<string, PatchEntry> = {};
  if (!update) return patches;
  for (const version of update.apps) {
    if (!atLeast(version, min)) continue;
    patches[version] = {
      data_version: update.data_version,
      data_files: update.data_files,
      translation_files: update.translation_files,
      bundle_files: readPatches[version]?.bundle_files ?? [],
    };
  }
  return patches;
}

/** The `app` and `patches` to publish (`build` `## deploy`, deploy list rule). */
export function nextDeployList(input: DeployListInput): DeployList {
  const app = input.read?.app ?? {};
  const readPatches = input.dbWiped ? {} : (input.read?.patches ?? {});
  const min = Object.keys(app).length === 0 ? null : lowestMinVersion(app);
  const patches = updateEntries(input, readPatches, min);
  for (const [version, entry] of Object.entries(readPatches)) {
    if (!(version in patches) && (input.compat === null || entry.data_version === input.compat)) patches[version] = entry;
  }
  if (input.patch) patches[input.patch.appVersion] = input.patch.entry;
  return { app, patches };
}
