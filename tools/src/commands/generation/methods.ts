import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { chooseMethods, IMAGE_METHOD, stageText, type MethodChoice } from './lib/select.ts';

export function choiceText(choice: MethodChoice): string {
  const lines = [`${choice.name} ${choice.kind} ${stageText(choice.stage)}`];
  if (choice.skill !== undefined) lines.push(`  skill ${choice.skill ?? 'not installed'}`);
  if (choice.cli !== undefined) lines.push(`  cli ${choice.cli ?? 'not installed'}`);
  if (choice.flux2Klein !== undefined) lines.push(`  ${IMAGE_METHOD} ${stageText(choice.flux2Klein)}`);
  return lines.join('\n');
}

export const methodsCommand: CommandDef = {
  name: ['generation', 'methods'],
  usage: 'ogw generation methods <game> <resource key>',
  async run(ctx, args) {
    expectPositionals(args, 2, 2, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const choices = await chooseMethods(ctx, await ctx.settings(), game, positional(args, 1, 'resource key'));
    return { text: choices.length === 0 ? 'none' : choices.map(choiceText).join('\n'), data: { methods: choices } };
  },
};
