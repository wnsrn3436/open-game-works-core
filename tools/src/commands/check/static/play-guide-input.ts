import { at, finding, type Finding, type StaticContext } from './lib/context.ts';

/**
 * play guide input: when the first platform of game settings `buildPlatforms`, which the judges' instances run, is a
 * desktop platform, `play-guide.md` names no `QACore` touch input command, since the game shows each device its own input
 * prompts and a touch shows the play agent and the judges prompts its players never see (`game-design` `## play guide`).
 * `tap_anchor` and the `touch_` commands, which are no words of prose, count anywhere; `tap` and `drag` count only as a
 * command with its position arguments (a code span or a code block line such as `tap 640 360`, after `ogw input
 * <instance>` or `input` of `ogw step --stream` or not) and as a `"command"` value of a timed input script in a code
 * block, so a quoted hint such as `drag a card onto a lane` or an action named `drag` does not count.
 */
export const NAME = 'play guide input';

const PATH = 'play-guide.md';
const DESKTOP = new Set(['macos', 'windows', 'linux']);
const NAMED = /\b(tap_anchor|touch_down|touch_move|touch_up)\b/g;
const SPAN = /`([^`]*)`/g;
/** `tap` or `drag` with only numbers or `<placeholders>` after it. */
const COMMAND = /^\s*(?:(?:ogw input \S+|input)\s+)?(tap|drag)(?:\s+(?:-?[0-9.]+|<[^>]+>))+\s*$/;
const SCRIPT_COMMAND = /"command"\s*:\s*"(tap|drag)"/g;
const FENCE = /^\s*(```|~~~)/;

function touchCommands(line: string, block: boolean): string[] {
  const named = [...line.matchAll(NAMED)].map((m) => m[1] as string);
  if (block) return [...named, ...[COMMAND.exec(line)?.[1]].filter((c) => c !== undefined), ...[...line.matchAll(SCRIPT_COMMAND)].map((m) => m[1] as string)];
  return [...named, ...[...line.matchAll(SPAN)].map((m) => COMMAND.exec(m[1] as string)?.[1]).filter((c) => c !== undefined)];
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  if (!sc.has(PATH)) return [];
  const platforms = (await sc.settings()).buildPlatforms ?? [];
  if (platforms[0] === undefined || !DESKTOP.has(platforms[0])) return [];
  const out: Finding[] = [];
  let block = false;
  for (const [i, line] of (await sc.text(PATH)).split(/\r?\n/).entries()) {
    if (FENCE.test(line)) {
      block = !block;
      continue;
    }
    for (const command of touchCommands(line, block)) {
      out.push(
        finding(
          NAME,
          at(PATH, i + 1),
          `\`${command}\` is a touch input, and the judges play this game on ${platforms[0]}, whose players use keys and the mouse; write a key, \`click_anchor <anchor>\`, or a drag as \`mouse_down left\`, \`mouse_move\` and \`mouse_up left\``,
        ),
      );
    }
  }
  return out;
}
