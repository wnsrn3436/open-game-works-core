import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd } from './lib/files.ts';
import type { Expr } from './lib/gd-ast.ts';
import { classIndex, mayBeA, resolverFor } from './lib/gd-shared.ts';
import type { TypeResolver } from './lib/gd-types.ts';
import { visitClass, type Scope } from './lib/gd-walk.ts';
import { nodeClass, sceneFiles } from './lib/scene-classes.ts';
import { strOf } from './lib/tscn.ts';

/**
 * finite tween (`client-content` Godot `## scene and prefab`): a tween preset that UICore plays as an open or close tween
 * or that MessageCore plays as an enter or exit tween has repeat count 0 (repeats forever). Those presets are the ones
 * that `open_tween` and `close_tween` written on the root of a `.tscn` under `resource/scene/` or `resource/prefab/`
 * whose root is a `UIPanel` or `UIPopup` name, and the ones that `MessageCore.toastEnterTween`,
 * `MessageCore.toastExitTween`, `MessageCore.blackBoxEnterTween` and `MessageCore.blackBoxExitTween` of the merged core
 * settings name. Tween key `tween/<name>` is `resource/tween/<name>.tres`, and a key with no file there is not checked.
 * Content code that assigns `open_tween` or `close_tween` of a `UIPanel` or `UIPopup` (with any assignment operator), or
 * passes one of those names as a string literal to `set()` or `set_deferred()` of one, is also reported. A receiver
 * whose type is not known counts as a `UIPanel`.
 */
export const NAME = 'finite tween';

const UI_CLASSES = ['UIPanel', 'UIPopup'] as const;
const UI_PROPS: readonly string[] = ['open_tween', 'close_tween'];
const MESSAGE_KEYS = ['MessageCore.toastEnterTween', 'MessageCore.toastExitTween', 'MessageCore.blackBoxEnterTween', 'MessageCore.blackBoxExitTween'] as const;
const SETTERS = new Set(['set', 'set_deferred']);

/** The preset file of a tween key and the line of its repeat count when it repeats forever; otherwise null. */
async function forever(sc: StaticContext, key: string): Promise<{ path: string; line: number } | null> {
  if (!key.startsWith('tween/')) return null;
  const path = `resource/${key}.tres`;
  if (!sc.has(path)) return null;
  const resource = (await sc.scene(path)).sections.find((s) => s.tag === 'resource');
  const repeat = resource?.props.get('repeat_count');
  if (repeat === undefined || repeat.value.t !== 'num' || repeat.value.v !== 0) return null;
  return { path, line: repeat.line };
}

async function sceneFindings(sc: StaticContext): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const path of sceneFiles(sc)) {
    const scene = await sc.scene(path);
    const root = scene.nodes[0];
    const written = root ? UI_PROPS.flatMap((name) => { const prop = root.props.get(name); return prop ? [{ name, prop }] : []; }) : [];
    if (!root || written.length === 0 || (await nodeClass(sc, scene, root, UI_CLASSES)) === null) continue;
    for (const { name, prop } of written) {
      const key = strOf(prop.value);
      const preset = key ? await forever(sc, key) : null;
      if (key && preset) out.push(finding(NAME, at(path, prop.line), `\`${name}\` names \`${key}\`, whose preset ${preset.path} repeats forever (repeat count 0)`));
    }
  }
  return out;
}

async function settingsFindings(sc: StaticContext): Promise<Finding[]> {
  const core = await sc.coreSettings();
  const out: Finding[] = [];
  for (const setting of MESSAGE_KEYS) {
    const key = core[setting];
    const preset = typeof key === 'string' && key !== '' ? await forever(sc, key) : null;
    if (preset) out.push(finding(NAME, at(preset.path, preset.line), `\`${setting}\` names \`${String(key)}\`, and this preset repeats forever (repeat count 0)`));
  }
  return out;
}

/** True when `recv.<name>` (or `<name>` of `self` when `recv` is null) is a UI property of a `UIPanel` or `UIPopup`. */
async function isUiProp(resolver: TypeResolver, recv: Expr | null, name: string): Promise<boolean> {
  if (!UI_PROPS.includes(name)) return false;
  if (recv === null && resolver.isLocal(name)) return false;
  for (const cls of UI_CLASSES) if (await mayBeA(resolver, recv, cls)) return true;
  return false;
}

async function codeFindings(sc: StaticContext): Promise<Finding[]> {
  const index = await classIndex(sc);
  const out: Finding[] = [];
  for (const path of sc.filter(isClientContentGd)) {
    const file = await sc.gd(path);
    const sites: { recv: Expr | null; name: string; line: number; scope: Scope }[] = [];
    visitClass(file.top, {
      stmt(s, scope) {
        if (s.k !== 'assign') return;
        if (s.target.k === 'member') sites.push({ recv: s.target.obj, name: s.target.name, line: s.line, scope });
        if (s.target.k === 'name') sites.push({ recv: null, name: s.target.name, line: s.line, scope });
      },
      expr(e, scope) {
        if (e.k !== 'call' || (e.callee.k !== 'member' && e.callee.k !== 'name') || !SETTERS.has(e.callee.name)) return;
        const first = e.args[0];
        if (first?.k === 'str') sites.push({ recv: e.callee.k === 'member' ? e.callee.obj : null, name: first.value, line: e.line, scope });
      },
    });
    const cache = new Map<unknown, TypeResolver>();
    for (const s of sites) {
      if (await isUiProp(resolverFor(index, file, s.scope, cache), s.recv, s.name)) {
        out.push(finding(NAME, at(path, s.line), `code sets \`${s.name}\` of a UIPanel or UIPopup; it is set in the .tscn`));
      }
    }
  }
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const code = await codeFindings(sc);
  if (!sc.files.some((p) => p.startsWith('resource/tween/') && p.endsWith('.tres'))) return code;
  return [...code, ...(await sceneFindings(sc)), ...(await settingsFindings(sc))];
}
