/** A base backup of `wal-g backup-list --detail --json`. */
export interface BaseBackup {
  name: string;
  /** `finish_time` as Unix ms. */
  finishedAt: number;
}

/** A timeline of `wal-g wal-show --detailed-json`. */
export interface Timeline {
  id: number;
  missingSegments: string[];
  /** Names of the base backups whose WAL from start to end is in the segments of this timeline. */
  backups: string[];
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The base backups of the JSON of `backup-list --detail --json`, or null when it is not that list. */
export function parseBackupList(value: unknown): BaseBackup[] | null {
  if (!Array.isArray(value)) return null;
  const backups: BaseBackup[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.backup_name !== 'string' || typeof item.finish_time !== 'string') return null;
    const finishedAt = Date.parse(item.finish_time);
    if (Number.isNaN(finishedAt)) return null;
    backups.push({ name: item.backup_name, finishedAt });
  }
  return backups;
}

/** The timelines of the JSON of `wal-show --detailed-json`, or null when it is not that list. `null` lists are empty. */
export function parseWalShow(value: unknown): Timeline[] | null {
  if (!Array.isArray(value)) return null;
  const timelines: Timeline[] = [];
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'number') return null;
    const missing = item.missing_segments ?? [];
    const backups = item.backups ?? [];
    if (!Array.isArray(missing) || !missing.every((s) => typeof s === 'string')) return null;
    if (!Array.isArray(backups) || !backups.every((b) => isObject(b) && typeof b.backup_name === 'string')) return null;
    timelines.push({ id: item.id, missingSegments: missing, backups: backups.map((b) => (b as { backup_name: string }).backup_name) });
  }
  return timelines;
}

const byFinish = (a: BaseBackup, b: BaseBackup): number => a.finishedAt - b.finishedAt;

export function newestBackup(backups: readonly BaseBackup[]): BaseBackup | null {
  return [...backups].sort(byFinish).at(-1) ?? null;
}

/** Most segment names a WAL check failure lists. */
const LISTED_SEGMENTS = 10;

/**
 * The WAL check of `ogw.md` `## backup test`: the reason it fails, or null when it passes. The oldest base backup must
 * be listed under a timeline, and that timeline and every later one must miss no segment.
 */
export function walCheckFailure(backups: readonly BaseBackup[], timelines: readonly Timeline[]): string | null {
  const oldest = [...backups].sort(byFinish)[0];
  if (oldest === undefined) return 'WAL check: the backup storage has no base backup';
  const home = timelines.find((t) => t.backups.includes(oldest.name));
  if (home === undefined) return `WAL check: wal-show lists the oldest base backup ${oldest.name} under no timeline: the backup storage does not hold its WAL from its start to its end`;
  const gaps = timelines.filter((t) => t.id >= home.id && t.missingSegments.length > 0).sort((a, b) => a.id - b.id);
  if (gaps.length === 0) return null;
  const lines = gaps.map((t) => {
    const shown = t.missingSegments.slice(0, LISTED_SEGMENTS).join(', ');
    const more = t.missingSegments.length > LISTED_SEGMENTS ? ` and ${String(t.missingSegments.length - LISTED_SEGMENTS)} more` : '';
    return `timeline ${String(t.id)} misses ${shown}${more}`;
  });
  return `WAL check: ${lines.join('; ')}`;
}

/** The age condition: the newest base backup finished less than twice `baseBackupIntervalMs` before the test started. */
export function ageFailure(newest: BaseBackup, startedAt: number, baseBackupIntervalMs: number): string | null {
  const age = startedAt - newest.finishedAt;
  if (age < 2 * baseBackupIntervalMs) return null;
  return `the newest base backup ${newest.name} finished ${String(age)} ms before the test started, not less than twice baseBackupIntervalMs (${String(2 * baseBackupIntervalMs)} ms)`;
}
