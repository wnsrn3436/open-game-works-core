import { describe, expect, it } from 'vitest';
import { addedConverters, parseConverters } from '../../../../src/commands/build/lib/converters.ts';

describe('converter list', () => {
  it('reads the entries and treats an absent file as empty', () => {
    expect(parseConverters(null, 'f')).toEqual([]);
    expect(parseConverters('[]', 'f')).toEqual([]);
    expect(parseConverters('[{"kind": "AUserState", "from_version": 3}]', 'f')).toEqual([{ kind: 'AUserState', fromVersion: 3 }]);
  });

  it('fails on text that is not a list of kind and integer from_version', () => {
    expect(() => parseConverters('x', 'f')).toThrow('f: not JSON');
    expect(() => parseConverters('{}', 'f')).toThrow('f: not a JSON array');
    for (const bad of ['[null]', '[{"kind": 1, "from_version": 1}]', '[{"kind": "A"}]', '[{"kind": "A", "from_version": 1.5}]', '[{"kind": "A", "from_version": "1"}]']) {
      expect(() => parseConverters(bad, 'f')).toThrow('f: entry 0 is not {"kind": <string>, "from_version": <integer>}');
    }
    expect(() => parseConverters('[{"kind": "A", "from_version": 1}, 2]', 'f')).toThrow('f: entry 1 is not');
  });

  it('lists the entries the last PROD build did not have, in the current order', () => {
    const last = [{ kind: 'A', fromVersion: 1 }, { kind: 'B', fromVersion: 2 }];
    const current = [{ kind: 'B', fromVersion: 3 }, { kind: 'A', fromVersion: 1 }, { kind: 'B', fromVersion: 2 }, { kind: 'A', fromVersion: 2 }];
    expect(addedConverters(last, current)).toEqual([{ kind: 'B', fromVersion: 3 }, { kind: 'A', fromVersion: 2 }]);
    expect(addedConverters(current, last)).toEqual([]);
  });
});
