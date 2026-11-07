// Oracle of seed S09 (result-rooms-count-wrong): the rooms value of the result panel equals the rooms the run cleared.
// A run cleared the first floor and went down to the second, then is given up on the pause popup; the result panel
// must count up to `crypt.rooms_cleared` of the content state, not to the rooms of the floor the run ended on.

interface Probe {
  language: string;
  command(name: string, ...args: string[]): Promise<{ ok: boolean; result: unknown }>;
}

interface Element {
  path: string;
  rect: [number, number, number, number];
  text: string;
  owner: string;
  button: boolean;
}

const PAUSE_POPUP = 'prefab/crypt/pause_popup';
const RESULT_PANEL = 'prefab/crypt/result_panel';
const POLLS = 150;
const POLL_MS = 200;

async function must(probe: Probe, name: string, ...args: string[]): Promise<unknown> {
  const answer = await probe.command(name, ...args);
  if (!answer.ok) throw new Error(`${name} ${args.join(' ')} failed: ${JSON.stringify(answer.result)}`);
  return answer.result;
}

async function state(probe: Probe): Promise<Record<string, unknown>> {
  return (await must(probe, 'get_state')) as Record<string, unknown>;
}

async function until(probe: Probe, what: string, test: (s: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> {
  for (let i = 0; i < POLLS; i++) {
    const s = await state(probe);
    if (test(s)) return s;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error(`${what} did not happen`);
}

async function elements(probe: Probe): Promise<Element[]> {
  return (await must(probe, 'list_ui')) as Element[];
}

function settled(s: Record<string, unknown>): boolean {
  return s.ui_flow === false && s.finite_tweens === 0;
}

export default async function probe(p: Probe): Promise<{ result: 'pass' | 'fail'; reason: string }> {
  await must(p, 'crypt.open_crypt');
  await must(p, 'crypt.descend');
  const content = (await state(p)).content as { crypt?: { rooms_cleared?: number } };
  const cleared = content.crypt?.rooms_cleared;
  if (typeof cleared !== 'number' || cleared <= 0) throw new Error(`the run cleared no room: ${JSON.stringify(content.crypt ?? null)}`);
  await must(p, 'key', 'P');
  await until(p, 'the pause popup opening', (s) => Array.isArray(s.popups) && s.popups.includes(PAUSE_POPUP) && settled(s));
  const abandon = (await elements(p)).find((e) => e.owner === PAUSE_POPUP && e.path.endsWith('/Buttons/Abandon'));
  if (abandon === undefined) throw new Error('the pause popup has no Abandon button');
  await must(p, 'tap', String(abandon.rect[0] + abandon.rect[2] / 2), String(abandon.rect[1] + abandon.rect[3] / 2));
  await until(p, 'the result panel opening', (s) => Array.isArray(s.panels) && s.panels.at(-1) === RESULT_PANEL && settled(s));
  const value = (await elements(p)).find((e) => e.owner === RESULT_PANEL && e.path.endsWith('/Hero/Rooms/Value'));
  if (value === undefined) throw new Error('the result panel has no rooms value');
  const shown = Number(value.text.replace(/\D/g, ''));
  if (shown === cleared) return { result: 'pass', reason: `the result shows ${String(shown)} rooms, the run cleared ${String(cleared)}` };
  return { result: 'fail', reason: `the result shows ${value.text} rooms, the run cleared ${String(cleared)}` };
}
