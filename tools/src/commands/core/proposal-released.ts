import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { markProposalReleased } from './api.ts';

/** `ogw core proposal released <game> <proposal file> <version>`. */
export const proposalReleasedCommand: CommandDef = {
  name: ['core', 'proposal', 'released'],
  usage: 'ogw core proposal released <game> <proposal file> <version>',
  async run(ctx, args) {
    expectPositionals(args, 3, 3, this.usage);
    const game = positional(args, 0, 'game');
    const file = positional(args, 1, 'proposal file');
    const version = positional(args, 2, 'version');
    const result = await markProposalReleased(ctx, game, file, version);
    const text = result === 'deferred'
      ? `deferred: ${game} has an open run; ${file} is marked released ${version} when the run ends`
      : `marked: ${file} released ${version}`;
    return { text, data: { result, file, version } };
  },
};
