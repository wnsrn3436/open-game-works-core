import { expectPositionals, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { rigMesh } from './lib/rig.ts';

/** `ogw resource rig-mesh --skeleton <file> --split <rig split JSON> --out <folder>`. */
export const rigMeshCommand: CommandDef = {
  name: ['resource', 'rig-mesh'],
  usage: 'ogw resource rig-mesh --skeleton <file> --split <rig split JSON> --out <folder>',
  options: { skeleton: { type: 'string' }, split: { type: 'string' }, out: { type: 'string' } },
  async run(_ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const skeleton = str(args, 'skeleton');
    const split = str(args, 'split');
    const out = str(args, 'out');
    if (skeleton === undefined || split === undefined || out === undefined) throw new OgwError(`usage: ${this.usage}`);
    const files = await rigMesh({ skeleton, split, out });
    return { text: files.length > 0 ? files.join('\n') : 'no part has weight bones', data: { files } };
  },
};
