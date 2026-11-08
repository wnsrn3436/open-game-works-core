import { describe, expect, it } from 'vitest';
import { ageFailure, newestBackup, parseBackupList, parseWalShow, walCheckFailure } from '../../../src/commands/backup/lib/judge.ts';

const backup = (name: string, finishedAt: number) => ({ name, finishedAt });
const timeline = (id: number, backups: string[], missingSegments: string[] = []) => ({ id, backups, missingSegments });

describe('backup test judging', () => {
  it('reads backup-list --detail --json and wal-show --detailed-json', () => {
    const list = [
      { backup_name: 'base_000000010000000000000002', time: '2026-11-01T00:00:01Z', finish_time: '2026-11-01T00:00:00.123456789Z', start_time: '2026-10-31T23:59:00Z' },
      { backup_name: 'base_000000010000000000000009', finish_time: '2026-11-02T00:00:00Z' },
    ];
    expect(parseBackupList(list)).toEqual([backup('base_000000010000000000000002', Date.UTC(2026, 10, 1, 0, 0, 0, 123)), backup('base_000000010000000000000009', Date.UTC(2026, 10, 2))]);
    expect(parseBackupList([])).toEqual([]);
    for (const bad of [null, {}, [{ backup_name: 'b' }], [{ backup_name: 'b', finish_time: 'yesterday' }], [{ backup_name: 1, finish_time: '2026-11-02T00:00:00Z' }]]) {
      expect(parseBackupList(bad)).toBeNull();
    }
    const show = [
      { id: 1, parent_id: 0, start_segment: '000000010000000000000001', end_segment: '000000010000000000000009', missing_segments: ['000000010000000000000004'], backups: [{ backup_name: 'b1', finish_time: 'x' }], status: 'LOST_SEGMENTS' },
      { id: 2, parent_id: 1, missing_segments: [], status: 'OK' },
      { id: 3, missing_segments: null, backups: null },
    ];
    expect(parseWalShow(show)).toEqual([timeline(1, ['b1'], ['000000010000000000000004']), timeline(2, []), timeline(3, [])]);
    for (const bad of [null, {}, [{ missing_segments: [] }], [{ id: 1, missing_segments: [4] }], [{ id: 1, backups: [{}] }]]) {
      expect(parseWalShow(bad)).toBeNull();
    }
  });

  it('passes the WAL check when the timeline of the oldest base backup and every later one miss no segment', () => {
    const backups = [backup('new', 20), backup('old', 10)];
    expect(walCheckFailure(backups, [timeline(1, ['old']), timeline(2, ['new'])])).toBeNull();
    // a timeline before the one of the oldest kept base backup is not read
    expect(walCheckFailure(backups, [timeline(1, [], ['000000010000000000000003']), timeline(2, ['old', 'new'])])).toBeNull();
    expect(walCheckFailure(backups, [timeline(1, ['old'], ['000000010000000000000003']), timeline(2, ['new'])])).toBe('WAL check: timeline 1 misses 000000010000000000000003');
    expect(walCheckFailure(backups, [timeline(1, ['old']), timeline(2, ['new'], ['A', 'B']), timeline(3, [], ['C'])])).toBe('WAL check: timeline 2 misses A, B; timeline 3 misses C');
    const many = Array.from({ length: 12 }, (_, i) => `S${String(i)}`);
    expect(walCheckFailure(backups, [timeline(1, ['old'], many)])).toBe('WAL check: timeline 1 misses S0, S1, S2, S3, S4, S5, S6, S7, S8, S9 and 2 more');
  });

  it('fails the WAL check without a base backup or when no timeline holds the WAL of the oldest one', () => {
    expect(walCheckFailure([], [timeline(1, [])])).toBe('WAL check: the backup storage has no base backup');
    expect(walCheckFailure([backup('new', 20), backup('old', 10)], [timeline(1, ['new'])])).toBe(
      'WAL check: wal-show lists the oldest base backup old under no timeline: the backup storage does not hold its WAL from its start to its end',
    );
  });

  it('takes the newest base backup and needs it to have finished less than twice baseBackupIntervalMs before the start', () => {
    const newest = newestBackup([backup('a', 5), backup('c', 30), backup('b', 20)]);
    expect(newest).toEqual(backup('c', 30));
    expect(newestBackup([])).toBeNull();
    expect(ageFailure(backup('c', 1000), 1000 + 2 * 3600 - 1, 3600)).toBeNull();
    expect(ageFailure(backup('c', 1000), 1000 + 2 * 3600, 3600)).toBe('the newest base backup c finished 7200 ms before the test started, not less than twice baseBackupIntervalMs (7200 ms)');
  });
});
