import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  compareVersions,
  filesBelow,
  isSimPath,
  pascalCase,
  gdscriptDataRefs,
  simulationTables,
  tableNames,
  tickChangedVersions,
} from '../../../../src/commands/generate/lib/sim.ts';
import { commitAll, gitInit, sh } from '../../../helpers/workspace.ts';
import { write } from '../helpers.ts';

function tempRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ogw-sim-'));
  gitInit(dir);
  return dir;
}

describe('helpers', () => {
  it('pascalCase, isSimPath, gdscriptDataRefs, compareVersions', () => {
    expect(pascalCase('level_wave_2')).toBe('LevelWave2');
    expect(isSimPath('client/features/match/sim/board.gd')).toBe(true);
    expect(isSimPath('client/features/match/sim/deep/x.gd')).toBe(true);
    expect(isSimPath('client/common/sim/x.gd')).toBe(true);
    expect(isSimPath('client/features/match/board.gd')).toBe(false);
    expect(isSimPath('client/features/a/b/sim/x.gd')).toBe(false);
    expect(isSimPath('client/common/x.gd')).toBe(false);
    expect(gdscriptDataRefs('var a = "GameData.X" # GameSetting\nvar b = \'q\\\'\' + GameData.Y')).toEqual({ containers: ['Y'], gameSetting: false });
    const tripleQuoted = 'extends RefCounted\n"""\nOld rule read GameData.ShopTable and GameSetting here\n"""\nvar c := r\'GameData.RawTable\'\nvar d := GameData.LiveTable\n';
    expect(gdscriptDataRefs(tripleQuoted)).toEqual({ containers: ['LiveTable'], gameSetting: false });
    const multiLine = 'var c := (GameData\n  .MultiTable)\nvar e := [GameData.\n  ListTable]\nvar f := GameData.\\\nContTable\nvar b := GameData.LiveTable\n';
    expect(gdscriptDataRefs(multiLine)).toEqual({ containers: ['MultiTable', 'ListTable', 'ContTable', 'LiveTable'], gameSetting: false });
    expect(['1.10.0', '1.2.0', '0.9.9', '1.2.10', '1.2.3'].sort(compareVersions)).toEqual(['0.9.9', '1.2.0', '1.2.3', '1.2.10', '1.10.0']);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
  });

  it('filesBelow lists nested files and nothing for a missing folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-fb-'));
    write(join(dir, 'a', 'b', 'c.txt'), 'x');
    write(join(dir, 'd.txt'), 'x');
    expect((await filesBelow(dir)).sort()).toEqual([join(dir, 'a', 'b', 'c.txt'), join(dir, 'd.txt')]);
    expect(await filesBelow(join(dir, 'none'))).toEqual([]);
  });
});

describe('simulation tables', () => {
  it('lists only the tables with a file in data/tables and data/system', async () => {
    const root = tempRepo();
    write(join(root, 'data', 'tables', 'level.csv'), '');
    write(join(root, 'data', 'tables', 'notes.txt'), '');
    write(join(root, 'data', 'system', 'game_setting.csv'), '');
    expect((await tableNames(root)).sort()).toEqual(['game_setting', 'level']);
    expect(await tableNames(tempRepo())).toEqual([]);
  });

  it('finds containers and the GameSetting accessor in deterministic simulation code only', async () => {
    const root = tempRepo();
    write(join(root, 'client', 'features', 'match', 'sim', 'board.gd'), 'var w := GameData.LevelWaveTable.get_row(1)\n# GameData.CommentTable\nvar s := "GameData.StringTable"\n');
    write(join(root, 'client', 'features', 'match', 'sim', 'deep', 'rules.gd'), 'var x := GameSetting.max_moves()\nvar y := GameData.UnknownTable\n');
    write(join(root, 'client', 'features', 'match', 'sim', 'data.json'), 'GameData.JsonTable');
    write(join(root, 'client', 'common', 'sim', 'r.gd'), 'var z := GameData.BTable.all_rows()\n');
    write(join(root, 'client', 'features', 'match', 'view.gd'), 'var v := GameData.ViewTable\n');
    write(join(root, 'client', 'features', 'readme.txt'), '');
    const tables = ['level_wave', 'comment', 'string', 'json', 'b', 'view'];
    expect(await simulationTables(root, tables)).toBe('table\nb\ngame_setting\nlevel_wave\n');
    expect(await simulationTables(tempRepo(), tables)).toBe('table\n');
  });
});

describe('tickChangedVersions', () => {
  it('lists versions of dev, stg and prod tags whose simulation files differ from the working tree', async () => {
    const root = tempRepo();
    write(join(root, 'client', 'features', 'match', 'sim', 'a.gd'), 'v1\n');
    write(join(root, 'client', 'features', 'match', 'view.gd'), 'view1\n');
    commitAll(root, 'one');
    sh(root, 'git', ['tag', 'dev-1.0.0']);
    sh(root, 'git', ['tag', '-a', 'prod-1.0.0', '-m', 'p']);
    write(join(root, 'client', 'features', 'match', 'sim', 'a.gd'), 'v2\n');
    commitAll(root, 'two');
    sh(root, 'git', ['tag', 'stg-1.10.0']);
    sh(root, 'git', ['tag', 'prod-1.2.0']);
    sh(root, 'git', ['tag', 'prod-1.2.0-bundle-1']);
    sh(root, 'git', ['tag', 'release-0.1.0']);
    write(join(root, 'client', 'features', 'match', 'view.gd'), 'view2\n');
    commitAll(root, 'three');
    sh(root, 'git', ['tag', 'dev-1.3.0']);
    expect(await tickChangedVersions(root)).toBe('export const TickChangedVersions: readonly string[] = ["1.0.0"];\n');
    write(join(root, 'client', 'common', 'sim', 'new.gd'), 'n\n');
    expect(await tickChangedVersions(root)).toBe(
      'export const TickChangedVersions: readonly string[] = ["1.0.0", "1.2.0", "1.3.0", "1.10.0"];\n',
    );
    rmSync(join(root, 'client', 'common'), { recursive: true });
    write(join(root, 'client', 'features', 'match', 'sim', 'a.gd'), 'v1\n');
    expect(await tickChangedVersions(root)).toBe(
      'export const TickChangedVersions: readonly string[] = ["1.2.0", "1.3.0", "1.10.0"];\n',
    );
  });

  it('gives an empty list without tags', async () => {
    const root = tempRepo();
    commitAll(root, 'empty');
    expect(await tickChangedVersions(root)).toBe('export const TickChangedVersions: readonly string[] = [];\n');
  });
});
