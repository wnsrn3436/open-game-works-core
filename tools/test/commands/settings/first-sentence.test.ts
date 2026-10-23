import { describe, expect, it } from 'vitest';
import { firstSentence } from '../../../src/commands/settings/lib/schema-nav.ts';

describe('firstSentence', () => {
  it('ends at the first "." before white space that does not end an abbreviation', () => {
    expect(firstSentence('Max wait in ms. Longer than the job.')).toBe('Max wait in ms.');
    expect(firstSentence('e.g. a URL. More.')).toBe('e.g. a URL.');
    expect(firstSentence('The endpoint, for example (e.g. eus) or i.e. this, etc. or vs. that. Rest.')).toBe('The endpoint, for example (e.g. eus) or i.e. this, etc. or vs. that.');
    expect(firstSentence('No end')).toBe('No end');
    expect(firstSentence(undefined)).toBe('');
  });
});
