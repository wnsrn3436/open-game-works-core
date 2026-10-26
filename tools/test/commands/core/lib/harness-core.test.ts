import { describe, expect, it } from 'vitest';
import { harnessCoreVersion, requireHarnessCore, requireSupportedCore } from '../../../../src/commands/core/lib/harness-core.ts';
import { createContext, type Context } from '../../../../src/lib/command.ts';
import { commitAll, makeWorkspace, sh, type TestWorkspace } from '../../../helpers/workspace.ts';

function context(ws: TestWorkspace): Context {
  return createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

/** A harness whose history is A, B (core-v0.4.0), C, and a side branch tagged core-v0.9.0 that HEAD does not contain. */
function taggedHarness(settings: Record<string, unknown> = {}): TestWorkspace {
  const ws = makeWorkspace(settings);
  sh(ws.harness, 'git', ['tag', 'core-v0.3.0']);
  commitAll(ws.harness, 'B');
  sh(ws.harness, 'git', ['tag', 'core-v0.4.0']);
  sh(ws.harness, 'git', ['tag', 'core-vbad']);
  sh(ws.harness, 'git', ['checkout', '--quiet', '-b', 'side']);
  commitAll(ws.harness, 'side');
  sh(ws.harness, 'git', ['tag', 'core-v0.9.0']);
  sh(ws.harness, 'git', ['checkout', '--quiet', 'main']);
  commitAll(ws.harness, 'C');
  return ws;
}

describe('harness core version', () => {
  it('is the highest core-v tag HEAD contains, or null without one', async () => {
    expect(await harnessCoreVersion(context(taggedHarness()))).toBe('0.4.0');
    expect(await harnessCoreVersion(context(makeWorkspace()))).toBeNull();
  });

  it('refuses a game core newer than the harness or older than minCoreVersion, and names the way out', async () => {
    const ctx = context(taggedHarness({ minCoreVersion: '0.2.0' }));
    await expect(requireSupportedCore(ctx, 'g', '0.4.0')).resolves.toBeUndefined();
    await expect(requireSupportedCore(ctx, 'g', '0.2.0')).resolves.toBeUndefined();
    await expect(requireSupportedCore(ctx, 'g', '0.5.0')).rejects.toThrow('g uses core 0.5.0, newer than this harness (core 0.4.0): use the harness at tag core-v0.5.0');
    await expect(requireSupportedCore(ctx, 'g', '0.1.0')).rejects.toThrow(
      'g uses core 0.1.0, older than harness settings minCoreVersion 0.2.0: raise the core of the game to 0.4.0 (ogw core upgrade g --version 0.4.0) or use the harness at tag core-v0.1.0',
    );
  });

  it('lets only the core of the harness write game code, and checks nothing with useLocalCore', async () => {
    const ctx = context(taggedHarness());
    await expect(requireHarnessCore(ctx, 'g', '0.4.0')).resolves.toBeUndefined();
    await expect(requireHarnessCore(ctx, 'g', '0.3.0')).rejects.toThrow('g uses core 0.3.0, and the specs of this harness are of core 0.4.0: raise the core of the game to 0.4.0');
    const local = context(taggedHarness({ useLocalCore: true, minCoreVersion: '0.4.0' }));
    await expect(requireHarnessCore(local, 'g', '0.1.0')).resolves.toBeUndefined();
    await expect(requireSupportedCore(local, 'g', '0.1.0')).resolves.toBeUndefined();
  });
});
