import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REAL_SETTINGS_KEYS, realHarness, testSettings } from './workspace.ts';

describe('test harness settings', () => {
  it('fixes every key of the real harness settings that is not a pin the tests take from it', () => {
    const real = JSON.parse(readFileSync(join(realHarness, 'settings.json'), 'utf8')) as Record<string, unknown>;
    const fixed = Object.keys(real).filter((key) => !REAL_SETTINGS_KEYS.includes(key)).sort();
    expect(Object.keys(testSettings()).sort()).toEqual(fixed);
  });
});
