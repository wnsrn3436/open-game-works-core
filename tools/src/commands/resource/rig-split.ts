import { expectPositionals, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { formatJson } from '../../lib/fsx.ts';
import { rigSplit } from './lib/rig.ts';

/** `ogw resource rig-split --source <file> --skeleton <file> --layers <folder> --size <width>x<height> --out <folder>`. */
export const rigSplitCommand: CommandDef = {
  name: ['resource', 'rig-split'],
  usage: 'ogw resource rig-split --source <file> --skeleton <file> --layers <folder> --size <width>x<height> --out <folder>',
  options: { source: { type: 'string' }, skeleton: { type: 'string' }, layers: { type: 'string' }, size: { type: 'string' }, out: { type: 'string' } },
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const source = str(args, 'source');
    const skeleton = str(args, 'skeleton');
    const layers = str(args, 'layers');
    const sizeText = str(args, 'size');
    const out = str(args, 'out');
    if (source === undefined || skeleton === undefined || layers === undefined || sizeText === undefined || out === undefined) throw new OgwError(`usage: ${this.usage}`);
    const match = /^([1-9][0-9]*)x([1-9][0-9]*)$/.exec(sizeText);
    if (!match) throw new OgwError(`--size ${sizeText} is not <width>x<height> in px integers`);
    const size: [number, number] = [Number(match[1]), Number(match[2])];
    const split = await rigSplit({ source, skeleton, layers, size, out }, (await ctx.settings()).rigCheck);
    return { text: formatJson(split), data: split };
  },
};
