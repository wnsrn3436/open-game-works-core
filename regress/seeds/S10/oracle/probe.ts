// Oracle of seed S10 (hud-stats-plate-overflow): every row of the HUD stats plate sits inside the plate with a margin,
// and each stat name keeps a gap to its value. Measured on the first room of a new run, once the HUD has settled.

interface Probe {
  language: string;
  command(name: string, ...args: string[]): Promise<{ ok: boolean; result: unknown }>;
}

interface Element {
  path: string;
  rect: [number, number, number, number];
  text: string;
}

/** The share of the plate height that must stay between the last row and the bottom edge of the plate. */
const BOTTOM_MARGIN_SHARE = 0.08;
/** The smallest gap, in window pixels, between a stat name and its value. */
const MIN_GAP_PX = 4;
const STATS = ['Damage', 'Tears', 'Range', 'ShotSpeed', 'Speed', 'Luck'];
const POLLS = 150;
const POLL_MS = 200;

async function must(probe: Probe, name: string, ...args: string[]): Promise<unknown> {
  const answer = await probe.command(name, ...args);
  if (!answer.ok) throw new Error(`${name} ${args.join(' ')} failed: ${JSON.stringify(answer.result)}`);
  return answer.result;
}

async function settle(probe: Probe): Promise<void> {
  for (let i = 0; i < POLLS; i++) {
    const s = (await must(probe, 'get_state')) as Record<string, unknown>;
    if (s.ui_flow === false && s.finite_tweens === 0) return;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  throw new Error('the HUD did not settle');
}

export default async function probe(p: Probe): Promise<{ result: 'pass' | 'fail'; reason: string }> {
  await must(p, 'crypt.open_crypt');
  await settle(p);
  const list = (await must(p, 'list_ui')) as Element[];
  const plate = list.find((e) => /(^|\/)Hud\/Stats$/.test(e.path));
  if (plate === undefined) throw new Error('the HUD has no stats plate on screen');
  const problems: string[] = [];
  const bottom = plate.rect[1] + plate.rect[3];
  for (const stat of STATS) {
    const name = list.find((e) => e.path === `${plate.path}/Grid/${stat}Name`);
    const value = list.find((e) => e.path === `${plate.path}/Grid/${stat}Value`);
    if (name === undefined || value === undefined) {
      problems.push(`${stat}: no name or value on screen`);
      continue;
    }
    const gap = value.rect[0] - (name.rect[0] + name.rect[2]);
    if (gap < MIN_GAP_PX) problems.push(`${stat}: ${String(gap)} px between name and value`);
    for (const element of [name, value]) {
      const below = bottom - (element.rect[1] + element.rect[3]);
      if (below < plate.rect[3] * BOTTOM_MARGIN_SHARE) problems.push(`${stat}: ${String(below)} px above the bottom of a ${String(plate.rect[3])} px plate`);
    }
  }
  if (problems.length > 0) return { result: 'fail', reason: problems.join('; ') };
  return { result: 'pass', reason: `every stats row inside the ${String(plate.rect[3])} px plate with a gap between name and value` };
}
