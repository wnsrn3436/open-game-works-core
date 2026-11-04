import { expectPositionals, positional, type CommandDef } from '../../lib/command.ts';
import { runData, type DataLine } from './api.ts';

/** The `WARN` lines of one data check code that the text prints; `--json` holds them all. */
const TEXT_WARNINGS_PER_CODE = 5;

function dataText(lines: readonly DataLine[]): string[] {
  const shown = new Map<string, number>();
  const out: string[] = [];
  for (const line of lines) {
    const count = line.level === 'WARN' ? (shown.get(line.code) ?? 0) + 1 : 0;
    if (line.level === 'WARN') shown.set(line.code, count);
    if (count <= TEXT_WARNINGS_PER_CODE) out.push(line.text);
  }
  for (const [code, count] of shown) {
    if (count > TEXT_WARNINGS_PER_CODE) out.push(`${String(count - TEXT_WARNINGS_PER_CODE)} more WARN ${code}, all in --json`);
  }
  return out;
}

export const data: CommandDef = {
  name: ['data'],
  usage: 'ogw data <game>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const game = await ctx.game(positional(args, 0, 'game'));
    const result = await runData(ctx, game);
    if (result.stderr.trim() !== '') ctx.log(result.stderr.trimEnd());
    const glossaryMissing = result.lines.filter((line) => line.code === 'glossary_missing').map((line) => line.text);
    return {
      exitCode: result.exitCode,
      text: dataText(result.lines).join('\n'),
      data: result,
      summary: { glossaryMissing },
    };
  },
};
