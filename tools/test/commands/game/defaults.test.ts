import { describe, expect, it } from 'vitest';
import { dayBoundaryText, defaultsText, displayValue, durationText } from '../../../src/commands/game/lib/defaults.ts';

describe('defaults list values', () => {
  it('gives a duration with the largest unit that divides it', () => {
    expect(durationText(2592000000)).toBe('30 d');
    expect(durationText(7200000)).toBe('2 h');
    expect(durationText(5400000)).toBe('90 min');
    expect(durationText(2000)).toBe('2 s');
    expect(durationText(1500)).toBe('1500 ms');
    expect(durationText(0)).toBe('0 ms');
  });

  it('gives the game day boundary as the time zone whose midnight it is', () => {
    expect(dayBoundaryText(0)).toBe('00:00 UTC');
    expect(dayBoundaryText(-32400000)).toBe('00:00 UTC+9');
    expect(dayBoundaryText(18000000)).toBe('00:00 UTC-5');
    expect(dayBoundaryText(-19800000)).toBe('00:00 UTC+5:30');
  });

  it('formats by the key', () => {
    expect(displayValue('core.auth.inactiveGuestDeleteAfterMs', null)).toBe('null');
    expect(displayValue('core.chat.retentionMs', 604800000)).toBe('7 d');
    expect(displayValue('pushConsent.nightEndMinute', 480)).toBe('08:00');
    expect(displayValue('core.routing.ipRateLimitPerMinute', 300)).toBe('300');
    expect(displayValue('dailyResetOffsetMs', -32400000)).toBe('00:00 UTC+9');
    expect(displayValue('sourceLanguage', 'en')).toBe('en');
    expect(displayValue('consent.ageBandBoundaries', [13, 16])).toBe('[13,16]');
  });

  it('writes one heading per group', () => {
    const value = { value: 1, source: 'schema default' as const, display: '1' };
    expect(
      defaultsText([
        { ...value, path: 'a', group: 'values to know', meaning: 'A' },
        { ...value, path: 'b', group: 'game settings', meaning: null },
        { ...value, path: 'c', group: 'game settings', meaning: 'C' },
      ]),
    ).toBe('## values to know\na = 1 (schema default): A\n\n## game settings\nb = 1 (schema default)\nc = 1 (schema default): C');
  });
});
