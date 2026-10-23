import { SCENARIO } from './bot-scenario.ts';
import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf, type CsvRow, type DataTable } from './lib/csv.ts';
import { repoPath } from './lib/files.ts';
import { isRecord, parseJsonWithLines } from './lib/json-pos.ts';
import { instanceChain, nodeClass, sceneFiles } from './lib/scene-classes.ts';
import { nodeInstance, strOf, type SceneNode, type TextScene } from './lib/tscn.ts';

/**
 * anchor reference: an anchor name that no `UIAnchor` node of `resource/scene/` and `resource/prefab/` has
 * (`tutorial_step` `anchor`, bot scenario and save fixture `tap_anchor`/`get_anchor` steps), a `tutorial_step` anchor
 * missing from its panel or popup prefab, and, with game settings `gamepadSupported`, an `AnchorTap` step anchor whose
 * UI element has no `UIButton` child.
 */
export const NAME = 'anchor reference';

const INDEXED = /^(.*)\.([0-9]+)$/;

export function baseName(anchor: string): string {
  const m = INDEXED.exec(anchor);
  return m ? (m[1] as string) : anchor;
}

interface AnchorNode {
  path: string;
  scene: TextScene;
  node: SceneNode;
  name: string;
}

async function anchorNodes(sc: StaticContext, path: string): Promise<AnchorNode[]> {
  const scene = await sc.scene(path);
  const out: AnchorNode[] = [];
  for (const node of scene.nodes) {
    const name = strOf(node.props.get('anchor_name')?.value);
    if (name !== null && (await nodeClass(sc, scene, node, ['UIAnchor'])) !== null) out.push({ path, scene, node, name });
  }
  return out;
}

/** Anchor names of a scene and the scenes it instances. */
async function anchorsOfScene(sc: StaticContext, path: string, seen = new Set<string>()): Promise<Set<string>> {
  const names = new Set<string>();
  if (seen.has(path) || !sc.has(path)) return names;
  seen.add(path);
  for (const a of await anchorNodes(sc, path)) names.add(a.name);
  const scene = await sc.scene(path);
  for (const node of scene.nodes) {
    const inst = nodeInstance(scene, node);
    const sub = inst === null ? null : repoPath(inst);
    if (sub !== null) for (const n of await anchorsOfScene(sc, sub, seen)) names.add(n);
  }
  return names;
}

function isNull(cell: string | undefined): boolean {
  return cell === undefined || cell === '' || cell === 'null';
}

async function stepFindings(sc: StaticContext, path: string, names: Set<string>): Promise<Finding[]> {
  if (!sc.has(path)) return [];
  let parsed;
  try {
    parsed = parseJsonWithLines(await sc.text(path));
  } catch {
    return [];
  }
  const steps = isRecord(parsed.value) && Array.isArray(parsed.value.steps) ? parsed.value.steps : [];
  const out: Finding[] = [];
  steps.forEach((step: unknown, i: number) => {
    if (!isRecord(step) || (step.command !== 'tap_anchor' && step.command !== 'get_anchor')) return;
    const first = Array.isArray(step.args) ? (step.args[0] as unknown) : undefined;
    if (typeof first === 'string' && !names.has(baseName(first))) {
      out.push(finding(NAME, at(path, parsed.lines.get(`/steps/${String(i)}`) ?? 1), `step anchor \`${first}\` is on no \`UIAnchor\``));
    }
  });
  return out;
}

async function panelFinding(sc: StaticContext, table: DataTable, row: CsvRow, anchor: string): Promise<Finding | null> {
  const panel = cellOf(table, row, 'panel');
  const popup = cellOf(table, row, 'popup');
  const key = !isNull(panel) ? panel : !isNull(popup) ? popup : null;
  if (key === null || key === undefined || INDEXED.test(anchor)) return null;
  const names = await anchorsOfScene(sc, `resource/${key}.tscn`);
  return names.has(anchor) ? null : finding(NAME, at(table.path, row.line), `anchor \`${anchor}\` is not in \`${key}\``);
}

/** Direct children of the root of the scene a node instances, following the root instance chain. */
async function instancedChildren(sc: StaticContext, scene: TextScene, node: SceneNode): Promise<{ scene: TextScene; node: SceneNode }[]> {
  const chain = (await instanceChain(sc, scene, node)).reverse();
  return chain.flatMap((sub) => sub.nodes.filter((n) => n.parent === '.').map((n) => ({ scene: sub, node: n })));
}

async function gamepadFindings(sc: StaticContext, anchors: AnchorNode[], tapAnchors: Set<string>): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const a of anchors) {
    if (!tapAnchors.has(a.name) || a.node.parent === null) continue;
    const siblings = a.scene.nodes.filter((n) => n.parent === a.node.parent && n !== a.node).map((n) => ({ scene: a.scene, node: n }));
    const element = a.scene.nodes.find((n) => n.path === a.node.parent);
    const children = [...siblings, ...(element ? await instancedChildren(sc, a.scene, element) : [])];
    let hasButton = false;
    for (const c of children) if ((await nodeClass(sc, c.scene, c.node, ['UIButton'])) !== null) hasButton = true;
    if (!hasButton) out.push(finding(NAME, at(a.path, a.node.line), `UI element of \`AnchorTap\` anchor \`${a.name}\` has no \`UIButton\` child`));
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const anchors = (await Promise.all(sceneFiles(sc).map((p) => anchorNodes(sc, p)))).flat();
  const names = new Set(anchors.map((a) => a.name));
  const out: Finding[] = [];
  const table = await sc.table('data/tables/tutorial_step.csv');
  const tapAnchors = new Set<string>();
  for (const row of table?.rows ?? []) {
    if (!table) break;
    const anchor = cellOf(table, row, 'anchor') ?? '';
    if (anchor === '') continue;
    if (!names.has(baseName(anchor))) out.push(finding(NAME, at(table.path, row.line), `anchor \`${anchor}\` is on no \`UIAnchor\``));
    const panel = await panelFinding(sc, table, row, anchor);
    if (panel) out.push(panel);
    if (cellOf(table, row, 'complete') === 'AnchorTap') tapAnchors.add(baseName(anchor));
  }
  out.push(...(await stepFindings(sc, SCENARIO, names)));
  for (const p of sc.filter((f) => f.startsWith('client/dev/bot/fixtures/') && f.endsWith('.json'))) out.push(...(await stepFindings(sc, p, names)));
  if ((await sc.settings()).gamepadSupported === true) out.push(...(await gamepadFindings(sc, anchors, tapAnchors)));
  return out;
}
