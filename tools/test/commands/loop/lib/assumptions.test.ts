import { describe, expect, it } from 'vitest';
import { assumptionItems, needsHumanLines } from '../../../../src/commands/loop/lib/assumptions.ts';

describe('assumptions.md', () => {
  const text = [
    '# assumptions',
    '',
    '- decision: before any item',
    '',
    '## game name (needs human)',
    '',
    '- decision: Hollow Run',
    '- evidence: genre noun',
    '- decision: second',
    '',
    '### detail',
    '',
    '## jump height',
    '',
    '  - decision:   3 tiles  ',
    '- evidence: needs human eyes in the body only',
    '',
    '## price needs human',
    '',
    '- evidence: none',
    '',
  ].join('\n');

  it('gives one item per ## heading with its first decision', () => {
    expect(assumptionItems(text)).toEqual([
      { question: 'game name', needsHuman: true, decision: 'Hollow Run' },
      { question: 'jump height', needsHuman: false, decision: '3 tiles' },
      { question: 'price', needsHuman: true, decision: null },
    ]);
    expect(assumptionItems('')).toEqual([]);
    expect(assumptionItems('## a ( needs human )\r\n-  decision: x\r\n')).toEqual([{ question: 'a', needsHuman: true, decision: 'x' }]);
  });

  it('gives the lines of the items whose heading line has needs human', () => {
    expect(needsHumanLines(text)).toEqual(['needs human: game name (decision: Hollow Run)', 'needs human: price (decision: none)']);
    expect(needsHumanLines('## a\n\n- decision: needs human\n')).toEqual([]);
  });
});
