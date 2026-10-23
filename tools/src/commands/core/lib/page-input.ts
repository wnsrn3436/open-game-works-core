import { Cdp, devtoolsEndpoint } from '../../build/lib/chromium.ts';
import type { TestInput } from '../../check/api.ts';
import { OgwError } from '../../../lib/errors.ts';
import { LIMITS } from '../../../lib/limits.ts';

/**
 * What puts a test host `POST /input` into the browser run's page (`unit-test-core` `### test host`): the DevTools
 * `Input.dispatchMouseEvent` or `Input.dispatchKeyEvent` on the page target whose URL starts with `pageUrl`. The
 * DevTools connection is made at the first input and closed by `close`.
 */
export function pageInput(profile: string, pageUrl: string, ended: () => string | null): { put: (input: TestInput) => Promise<void>; close: () => void } {
  let session: Promise<{ cdp: Cdp; sessionId: string }> | null = null;
  const open = async (): Promise<{ cdp: Cdp; sessionId: string }> => {
    const cdp = await Cdp.connect(await devtoolsEndpoint(profile, ended, LIMITS.shortMs), LIMITS.shortMs);
    try {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const page = (Array.isArray(targetInfos) ? targetInfos : []).find(
        (t: unknown) => typeof t === 'object' && t !== null && (t as { type?: unknown }).type === 'page' && String((t as { url?: unknown }).url).startsWith(pageUrl),
      ) as { targetId: string } | undefined;
      if (page === undefined) throw new OgwError(`no browser page at ${pageUrl}`);
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: page.targetId, flatten: true });
      if (typeof sessionId !== 'string') throw new OgwError('DevTools Target.attachToTarget gave no sessionId');
      // the headless browser cannot ask for clipboard writes and leaves them at prompt; a person's browser writes
      // without asking within a user activation (`client-core` Godot `## test`)
      await cdp.send('Browser.grantPermissions', { permissions: ['clipboardSanitizedWrite'], origin: new URL(pageUrl).origin });
      return { cdp, sessionId };
    } catch (error) {
      // a failed open is tried again at the next input: its connection is not left open
      cdp.close();
      throw error;
    }
  };
  return {
    put: async (input) => {
      // a failed open is not kept: the next input tries again (the page may not be listed yet)
      session ??= open().catch((error: unknown) => {
        session = null;
        throw error;
      });
      const { cdp, sessionId } = await session;
      if (input.type === 'click') {
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', { type, x: input.x, y: input.y, button: 'left', clickCount: 1 }, sessionId);
        }
        return;
      }
      // a printable key (one character) also types its text, as a key press of a person does
      const text = /^.$/u.test(input.key) ? { text: input.key } : {};
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: input.key, ...text }, sessionId);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: input.key }, sessionId);
    },
    close: () => {
      void session?.then(({ cdp }) => {
        cdp.close();
      }, () => undefined);
    },
  };
}
