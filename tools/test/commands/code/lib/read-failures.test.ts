import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { auditFailures } from '../../../../src/commands/code/lib/dependency.ts';
import { coreEngines } from '../../../../src/commands/code/lib/target.ts';

describe('auditFailures', () => {
  it('reads the high and critical packages, null for output that is not JSON, and throws a report of another form', () => {
    expect(auditFailures('{"vulnerabilities": {"a": {"severity": "high"}, "b": {"severity": "low"}, "c": {"severity": "critical"}}}')).toEqual(['a high', 'c critical']);
    expect(auditFailures('npm ERR! audit endpoint returned an error')).toBeNull();
    // a report entry that is not an object is no output that is not JSON: the error is thrown
    expect(() => auditFailures('{"vulnerabilities": {"a": null}}')).toThrow(TypeError);
  });
});

describe('coreEngines', () => {
  it('lists the engines with an engine.json, none without client/, and throws a client/ it cannot read', async () => {
    const root = mkdtempSync(join(tmpdir(), 'ogw-engines-'));
    expect(await coreEngines(root)).toEqual([]);
    mkdirSync(join(root, 'client', 'godot'), { recursive: true });
    mkdirSync(join(root, 'client', 'unity'), { recursive: true });
    writeFileSync(join(root, 'client', 'godot', 'engine.json'), '{}');
    expect(await coreEngines(root)).toEqual(['godot']);
    // a file where client/ is
    const file = mkdtempSync(join(tmpdir(), 'ogw-engines-'));
    writeFileSync(join(file, 'client'), '');
    await expect(coreEngines(file)).rejects.toMatchObject({ code: 'ENOTDIR' });
  });
});
