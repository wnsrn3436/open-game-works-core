import { describe, expect, it } from 'vitest';
import * as nineSliceSize from '../../../../src/commands/check/static/nine-slice-size.ts';
import { lines, memContext } from './helpers.ts';

describe('nine slice size', () => {
  it('fails a placeholder or requested nine_slice whose size long side is under 256', async () => {
    const sc = memContext({
      'resource/resources.csv': [
        'key,description,spec,status,method,source,license,attribution,sha256',
        'nine_slice/small,x,"size=128x128;slice=8,8,8,8",placeholder,,,,,',
        'nine_slice/tall,x,"size=32x255;slice=8,8,8,8",requested,,,,,',
        'nine_slice/edge,x,"size=256x32;slice=8,8,8,8",placeholder,,,,,',
        'nine_slice/done,x,"size=64x64;slice=8,8,8,8",final,,,,,',
        'nine_slice/temp,x,"size=64x64;slice=8,8,8,8",temporary,,,,,',
        'icon/small,x,size=64x64,placeholder,,,,,',
        '',
      ].join('\n'),
    });
    expect(lines(await nineSliceSize.run(sc))).toEqual([
      'resource/resources.csv:2 | nine slice size: the long side of the size of `nine_slice/small` is under 256; make it 256 or more',
      'resource/resources.csv:3 | nine slice size: the long side of the size of `nine_slice/tall` is under 256; make it 256 or more',
    ]);
  });

  it('passes a game without resources.csv', async () => {
    expect(await nineSliceSize.run(memContext({}))).toEqual([]);
  });
});
