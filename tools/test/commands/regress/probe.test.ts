import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { automationRequest, restartClient } from '../../../src/commands/instance/automation.ts';
import { startInstance, stopInstance } from '../../../src/commands/instance/api.ts';
import { runOracle } from '../../../src/commands/regress/lib/probe.ts';
import { parseManifest } from '../../../src/commands/regress/lib/repo.ts';
import { makeWorkspace, realHarness } from '../../helpers/workspace.ts';
import { ctxOf, write } from './helpers.ts';

vi.mock('../../../src/commands/instance/api.ts', () => ({ startInstance: vi.fn(), stopInstance: vi.fn(() => Promise.resolve()) }));
vi.mock('../../../src/commands/instance/automation.ts', () => ({ automationRequest: vi.fn(), restartClient: vi.fn(() => Promise.resolve({})) }));

beforeEach(() => {
  vi.mocked(startInstance).mockReset().mockResolvedValue({ id: 'i1' } as Awaited<ReturnType<typeof startInstance>>);
  vi.mocked(stopInstance).mockClear();
  vi.mocked(restartClient).mockClear();
  vi.mocked(automationRequest).mockReset();
});

const PROBE = `export default async function probe(p) {
  const answer = await p.command('crypt.state', p.language);
  return answer.result === 'good' ? { result: 'pass', reason: p.language + ' good' } : { result: 'fail', reason: p.language + ' bad' };
}
`;

describe('oracle', () => {
  it('starts one instance with the fixture, calls the probe per language after set_language, and stops the instance', async () => {
    const ws = makeWorkspace();
    const folder = join(ws.root, 'oracle');
    write(folder, 'oracle.json', JSON.stringify({ probe: 'probe.mjs', languages: ['ko', 'en'], fixture: 'fixture.json' }));
    write(folder, 'probe.mjs', PROBE);
    write(folder, 'fixture.json', '{"steps": []}');
    vi.mocked(automationRequest).mockResolvedValue({ ok: true, result: 'good', bytes: Buffer.alloc(0), frames: [], framePaths: [] });
    expect(await runOracle(ctxOf(ws), 'g', 'c1', folder)).toEqual({ result: 'pass', reason: 'ko: ko good; en: en good' });
    expect(vi.mocked(startInstance).mock.calls[0]?.[1]).toEqual({ game: 'g', commit: 'c1', client: 'window', fixture: join(folder, 'fixture.json') });
    expect(vi.mocked(restartClient).mock.calls.map((c) => c[3]?.args)).toEqual([['ko'], ['en']]);
    expect(vi.mocked(automationRequest).mock.calls.map((c) => [c[2], c[3]])).toEqual([['crypt.state', ['ko']], ['crypt.state', ['en']]]);
    expect(vi.mocked(stopInstance)).toHaveBeenCalledWith(expect.anything(), 'i1');
  });

  it('is fail at the first failing language, and unknown when the probe throws, does not load or the instance does not start', async () => {
    const ws = makeWorkspace();
    const folder = join(ws.root, 'oracle');
    write(folder, 'oracle.json', JSON.stringify({ probe: 'probe.mjs', languages: ['ko', 'en'] }));
    write(folder, 'probe.mjs', PROBE);
    vi.mocked(automationRequest).mockResolvedValueOnce({ ok: true, result: 'bad', bytes: Buffer.alloc(0), frames: [], framePaths: [] });
    expect(await runOracle(ctxOf(ws), 'g', 'c1', folder)).toEqual({ result: 'fail', reason: 'ko: ko bad' });
    expect(vi.mocked(startInstance).mock.calls[0]?.[1]).toEqual({ game: 'g', commit: 'c1', client: 'window' });
    vi.mocked(automationRequest).mockRejectedValueOnce(new Error('channel closed'));
    expect(await runOracle(ctxOf(ws), 'g', 'c1', folder)).toEqual({ result: 'unknown', reason: 'the probe threw: channel closed' });
    expect(vi.mocked(stopInstance)).toHaveBeenCalledTimes(2);
    vi.mocked(startInstance).mockRejectedValueOnce(new Error('no slot'));
    expect(await runOracle(ctxOf(ws), 'g', 'c1', folder)).toEqual({ result: 'unknown', reason: 'the instance did not start: no slot' });
    write(folder, 'oracle.json', JSON.stringify({ probe: 'missing.mjs', languages: ['ko'] }));
    expect((await runOracle(ctxOf(ws), 'g', 'c1', folder)).reason).toMatch(/missing\.mjs not found$/);
    write(folder, 'oracle.json', JSON.stringify({ probe: 'probe.mjs', languages: [] }));
    expect((await runOracle(ctxOf(ws), 'g', 'c1', folder)).reason).toContain('with at least one language');
  });
});

describe('the first seeds of regress/', () => {
  it('have manifests without problems, states of regress/states.json, a patch each, and the oracle files they name', () => {
    const root = join(realHarness, 'regress');
    const states = (JSON.parse(readFileSync(join(root, 'states.json'), 'utf8')) as { state: string; game: string; commit: string }[]).map((s) => s.state);
    const ids = readdirSync(join(root, 'seeds'));
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) {
      const folder = join(root, 'seeds', id);
      const { manifest, problems } = parseManifest(JSON.parse(readFileSync(join(folder, 'seed.json'), 'utf8')));
      expect(problems, id).toEqual([]);
      expect(states, id).toContain(manifest.state);
      const files = readdirSync(folder);
      expect(files.some((f) => /^patch-\d+\.\d+\.\d+\.diff$/.test(f)), id).toBe(true);
      if (manifest.oracle) {
        expect(files.some((f) => /^reference-\d+\.\d+\.\d+\.diff$/.test(f)), id).toBe(true);
        const oracle = JSON.parse(readFileSync(join(folder, 'oracle', 'oracle.json'), 'utf8')) as { probe: string };
        expect(readdirSync(join(folder, 'oracle')), id).toContain(oracle.probe);
      }
    }
  });
});
