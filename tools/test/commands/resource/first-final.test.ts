import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { historicalStatuses } from '../../../src/commands/resource/lib/first-final.ts';
import { ogw, commitAll, sh } from '../../helpers/workspace.ts';
import { listCsv, makeFixture, type Fixture, type Row } from './fixture.ts';

function setRows(f: Fixture, rows: Row[], message?: string): void {
  writeFileSync(join(f.game, 'resource/resources.csv'), listCsv(rows));
  if (message !== undefined) commitAll(f.game, message);
}

function files(f: Fixture, paths: string[]): void {
  for (const path of paths) {
    mkdirSync(join(f.game, path, '..'), { recursive: true });
    writeFileSync(join(f.game, path), 'x');
  }
}

const img = (status: string): Row => ({ key: 'image/hero', spec: 'size=8x8', status });
const ico = (status: string): Row => ({ key: 'icon/hero', spec: 'size=8x8', status });

describe('ogw resource first-final', () => {
  it('gives the row whose last change to final is earliest', async () => {
    const f = makeFixture({ 'resource/resources.csv': listCsv([img('placeholder'), ico('placeholder')]) });
    files(f, ['resource/image/hero.png', 'resource/icon/hero.png']);
    setRows(f, [img('placeholder'), ico('final')], 'icon final');
    setRows(f, [img('final'), ico('final')], 'image final');
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero'])).stdout).toBe('icon/hero\nresource/icon/hero.png\n');
    setRows(f, [img('final'), ico('requested')], 'icon requested');
    setRows(f, [img('final'), ico('final')], 'icon final again');
    const run = await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero', '--json']);
    expect(JSON.parse(run.stdout)).toEqual({ key: 'image/hero', files: ['resource/image/hero.png'] });
  });

  it('orders rows that turned final in one commit by key bytes, and uncommitted ones last', async () => {
    const f = makeFixture({ 'resource/resources.csv': listCsv([img('placeholder'), ico('placeholder')]) });
    files(f, ['resource/image/hero.png', 'resource/icon/hero.png', 'resource/model/hero.glb']);
    setRows(f, [img('final'), ico('final')], 'both');
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero'])).stdout).toBe('icon/hero\nresource/icon/hero.png\n');
    setRows(f, [img('requested'), ico('requested'), { key: 'model/hero', spec: 'bounds=1x1x1', status: 'final' }]);
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero'])).stdout).toBe('model/hero\nresource/model/hero.glb\n');
  });

  it('puts a row that is final only in the working tree after a committed final row', async () => {
    const f = makeFixture({ 'resource/resources.csv': listCsv([img('placeholder'), ico('placeholder')]) });
    files(f, ['resource/image/hero.png', 'resource/icon/hero.png']);
    setRows(f, [img('final'), ico('placeholder')], 'image final');
    setRows(f, [img('final'), ico('final')]);
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero'])).stdout).toBe('image/hero\nresource/image/hero.png\n');
  });

  it('does not count a merge as a change to final when a parent has the row final', async () => {
    const f = makeFixture({ 'resource/resources.csv': listCsv([img('placeholder'), ico('placeholder')]) });
    files(f, ['resource/image/hero.png', 'resource/icon/hero.png']);
    commitAll(f.game, 'files');
    const main = sh(f.game, 'git', ['rev-parse', '--abbrev-ref', 'HEAD']).trim();
    const merge = (branch: string): void => {
      sh(f.game, 'git', ['merge', '--quiet', '--no-ff', '-m', `merge ${branch}`, branch]);
    };
    sh(f.game, 'git', ['checkout', '--quiet', '-b', 'work']);
    sh(f.game, 'git', ['checkout', '--quiet', '-b', 'sub1']);
    setRows(f, [img('final'), ico('placeholder')], 'image final');
    sh(f.game, 'git', ['checkout', '--quiet', 'work']);
    merge('sub1');
    sh(f.game, 'git', ['checkout', '--quiet', '-b', 'sub2']);
    setRows(f, [img('final'), ico('final')], 'icon final');
    sh(f.game, 'git', ['checkout', '--quiet', 'work']);
    merge('sub2');
    sh(f.game, 'git', ['checkout', '--quiet', main]);
    merge('work');
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero'])).stdout).toBe('image/hero\nresource/image/hero.png\n');
  });

  it('gives no status from a list in history that cannot be read', async () => {
    const f = makeFixture({ 'resource/resources.csv': listCsv([img('placeholder'), ico('placeholder')]) });
    files(f, ['resource/image/hero.png', 'resource/icon/hero.png']);
    setRows(f, [img('final'), ico('placeholder')], 'image final');
    writeFileSync(join(f.game, 'resource/resources.csv'), listCsv([img('placeholder'), ico('final'), ico('final')]));
    commitAll(f.game, 'duplicate key');
    writeFileSync(join(f.game, 'resource/resources.csv'), 'other,header\n"unclosed\n');
    commitAll(f.game, 'not a list');
    setRows(f, [img('final'), ico('final')], 'both final');
    // image/hero: final at "image final", no status at the two bad commits, final again at "both final".
    // icon/hero: no status at the bad commits, so its last change to final is "both final", like image/hero.
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero'])).stdout).toBe('icon/hero\nresource/icon/hero.png\n');
    expect(historicalStatuses(listCsv([img('final'), ico('final'), ico('final')]))).toEqual(new Map([['image/hero', 'final']]));
    expect(historicalStatuses('key,status\nimage/hero,final\n')).toEqual(new Map([['image/hero', 'final']]));
    expect(historicalStatuses('"unclosed\n')).toEqual(new Map());
    expect(historicalStatuses('key,other\nimage/hero,final\n')).toEqual(new Map());
  });

  it('chooses by speaker and lists variant files', async () => {
    const f = makeFixture({
      'resource/resources.csv': listCsv([
        { key: 'voice/a', spec: 'length=5', status: 'final', speaker: 'mira', text_key: 'k' },
        { key: 'voice/b', spec: 'length=5', status: 'final', speaker: 'joe', text_key: 'k' },
        { key: 'sfx/hit', spec: 'length=5;variants=2', status: 'final' },
      ]),
    });
    files(f, ['resource/voice/a.wav', 'resource/voice/b.wav', 'resource/sfx/hit.1.wav', 'resource/sfx/hit.2.wav']);
    commitAll(f.game, 'files');
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--speaker', 'joe'])).stdout).toBe('voice/b\nresource/voice/b.wav\n');
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hit'])).stdout).toBe('sfx/hit\nresource/sfx/hit.1.wav\nresource/sfx/hit.2.wav\n');
  });

  it('gives none when no row is final, and changes nothing', async () => {
    const f = makeFixture({ 'resource/resources.csv': listCsv([img('requested')]) });
    const run = await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero']);
    expect(run).toMatchObject({ code: 0, stdout: 'none\n' });
    expect(JSON.parse((await ogw(f.ws, ['resource', 'first-final', 'g', '--speaker', 'x', '--json'])).stdout)).toEqual({ key: null, files: [] });
    expect(sh(f.game, 'git', ['status', '--porcelain'])).toBe('');
  });

  it('works in a repo without a list at some commits and fails without the file', async () => {
    const f = makeFixture({});
    mkdirSync(join(f.game, 'resource'));
    setRows(f, [img('final')], 'final');
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'hero'])).stderr).toContain('image/hero: no file resource/image/hero.<extension>');
  });

  it('needs one of --name and --speaker', async () => {
    const f = makeFixture({});
    expect((await ogw(f.ws, ['resource', 'first-final', 'g'])).stderr).toContain('usage: ogw resource first-final');
    expect((await ogw(f.ws, ['resource', 'first-final', 'g', '--name', 'a', '--speaker', 'b'])).code).toBe(1);
    expect((await ogw(f.ws, ['resource', 'first-final', '--name', 'a'])).code).toBe(1);
  });
});
