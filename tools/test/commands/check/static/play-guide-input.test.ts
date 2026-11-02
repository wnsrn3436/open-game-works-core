import { describe, expect, it } from 'vitest';
import * as playGuideInput from '../../../../src/commands/check/static/play-guide-input.ts';
import { lines, memContext } from './helpers.ts';

const GUIDE = [
  '## game flow',
  '',
  '1. terms popup `tap_anchor terms_agree_all` → `ogw input <id> tap_anchor terms_confirm`',
  '2. move with `key_down w`, drop a block with `tap 640 360` or `ogw input <id> drag 0 0 9 9 300`, then tap the screen',
  '3. menu: press tap_anchor menu_start, or hold with touch_down 0 10 10',
  '',
  '```json',
  '{"steps": [{"atMs": 0, "command": "drag", "args": ["0", "0", "9", "9", "300"]}]}',
  '```',
  '```',
  'input tap 640 360',
  'step 3',
  '```',
  '4. the hint reads `drag a card onto a lane`, the action `drag` moves it, `mouse_drag` is no command, and `click_anchor menu_start` is a click',
  '',
].join('\n');

const why = (command: string, platform: string): string =>
  `play guide input: \`${command}\` is a touch input, and the judges play this game on ${platform}, whose players use keys and the mouse; write a key, \`click_anchor <anchor>\`, or a drag as \`mouse_down left\`, \`mouse_move\` and \`mouse_up left\``;

describe('play guide input', () => {
  it('fails the touch commands of the guide of a game whose first platform is a desktop platform', async () => {
    const sc = memContext({ 'settings.json': { buildPlatforms: ['macos', 'ios'] }, 'play-guide.md': GUIDE });
    const at = (line: number, command: string): string => `play-guide.md:${String(line)} | ${why(command, 'macos')}`;
    expect(lines(await playGuideInput.run(sc))).toEqual([
      at(3, 'tap_anchor'),
      at(3, 'tap_anchor'),
      at(4, 'drag'),
      at(4, 'tap'),
      at(5, 'tap_anchor'),
      at(5, 'touch_down'),
      at(8, 'drag'),
      at(11, 'tap'),
    ]);
  });

  it('passes a game whose first platform is mobile or web, a guide with no touch command and a game with no guide', async () => {
    expect(await playGuideInput.run(memContext({ 'settings.json': { buildPlatforms: ['ios', 'macos'] }, 'play-guide.md': GUIDE }))).toEqual([]);
    expect(await playGuideInput.run(memContext({ 'settings.json': { buildPlatforms: ['web'] }, 'play-guide.md': GUIDE }))).toEqual([]);
    const keys = '## game flow\n\n1. `key Enter`, then `click_anchor menu_start`; tap the brakes in prose\n2. drag with `mouse_down left 1 1`\n';
    expect(await playGuideInput.run(memContext({ 'settings.json': { buildPlatforms: ['macos'] }, 'play-guide.md': keys }))).toEqual([]);
    expect(await playGuideInput.run(memContext({ 'settings.json': { buildPlatforms: ['macos'] } }))).toEqual([]);
  });
});
