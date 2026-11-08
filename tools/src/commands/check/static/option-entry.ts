import { CORE_ACTIONS } from './action-reference.ts';
import { absence, at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf } from './lib/csv.ts';
import { isClientContentGd, isClientDev, isClientTest } from './lib/files.ts';
import type { Expr } from './lib/gd-ast.ts';
import { callsOf } from './lib/gd-shared.ts';
import { chainText } from './lib/gd-walk.ts';
import { inputMapActions, PROJECT_FILE } from './lib/input-map.ts';
import { isRecord } from './lib/json-pos.ts';
import { sceneFiles } from './lib/scene-classes.ts';
import { settingsLine } from './lib/settings-lines.ts';

/**
 * option entry (`client-content` `## core usage`): client content code outside `client/dev/` and `client/tests/` lacks
 * a call the option screen needs, or the module of such a call is not a module the game uses. A missing call or module
 * has no line; `where` points at what makes the entry required (ogw.md `## static check`). Also a `SoundCore.play`,
 * `get_volume` or `set_volume` call whose bus argument is not a `SoundCore.SoundBus` element, at its line.
 */
export const NAME = 'option entry';

const ALWAYS = [
  'AuthCore.open_terms_document',
  'AuthCore.withdraw',
  'AuthCore.get_public_code',
  'NativeUiCore.copy_text',
  'UICore.open_licenses',
  'AuthCore.issue_deletion_code',
  'SoundCore.reset_volume_settings',
];
const LANGUAGE = ['LocalizationCore.list_languages', 'LocalizationCore.get_language', 'LocalizationCore.select_language', 'BootstrapCore.request_restart'];
const SCREEN_MODE = ['ResolutionCore.is_screen_mode_supported', 'ResolutionCore.get_screen_mode', 'ResolutionCore.set_screen_mode'];
const KEY_BINDINGS = ['InputCore.get_keys', 'InputCore.wait_key', 'InputCore.set_keys', 'InputCore.cancel_wait_key', 'InputCore.reset_keys'];
const PAD_BINDINGS = ['InputCore.get_pad_buttons', 'InputCore.wait_pad_button', 'InputCore.set_pad_buttons', 'InputCore.cancel_wait_key', 'InputCore.reset_pad_buttons'];
const TEXT_SCALE = ['AccessibilityCore.list_text_scales', 'AccessibilityCore.get_settings', 'AccessibilityCore.set_text_scale'];
const SCREEN_MODE_PLATFORMS = ['windows', 'macos', 'linux'];
const KEYBOARD_PLATFORMS = ['windows', 'macos', 'linux', 'web'];

/** Entries whose condition is a call: the calling chain and the calls the entry needs. */
const CALL_ENTRIES: [string, string[]][] = [
  ['SoundCore.play_haptic', ['SoundCore.is_haptic_enabled', 'SoundCore.set_haptic_enabled']],
  ['AccessibilityCore.play_voice', ['AccessibilityCore.get_settings', 'AccessibilityCore.set_subtitles']],
  ['CameraCore.shake', ['AccessibilityCore.get_settings', 'AccessibilityCore.set_reduce_shake']],
  ['ScreenEffectCore.flash', ['AccessibilityCore.get_settings', 'AccessibilityCore.set_reduce_flash']],
];

/** The calls whose argument at that index is a `SoundBus`. */
const BUS_ARG: Record<string, number> = { 'SoundCore.play': 1, 'SoundCore.get_volume': 0, 'SoundCore.set_volume': 0 };
const BUS_ELEMENT = /^SoundCore\.SoundBus\.(MASTER|BGM|SFX|VOICE|UI)$/;
/** The buses a `SoundCore.play` call plays. */
const PLAY_BUSES = new Set(['SFX', 'VOICE', 'UI']);
const POSITIONAL_PLAYERS = new Set(['AudioStreamPlayer2D', 'AudioStreamPlayer3D']);
const POSITIONAL_NEW = new Set([...POSITIONAL_PLAYERS].map((c) => `${c}.new`));

/** One call an entry needs: a chain, and for a volume call the `SoundBus` member its bus argument names. */
interface Need {
  chain: string;
  bus?: string;
}

interface Requirement {
  needs: Need[];
  where: string;
}

/** What client content code calls and plays. */
interface CodeScan {
  /** Called chains, and `<chain> <bus member>` for volume calls. */
  called: Set<string>;
  /** First call of each chain. */
  firstCall: Map<string, string>;
  /** First place that plays each bus (`SoundBus` member). */
  played: Map<string, string>;
  /** Calls whose bus argument is not a `SoundBus` element. */
  badBus: Finding[];
}

function needKey(need: Need): string {
  return need.bus === undefined ? need.chain : `${need.chain} ${need.bus}`;
}

/** The path of the first `login-apple` or `login-google` adapter of an environment that is not `null`: it makes social login entries required. */
function socialLogin(settings: Record<string, unknown>): string | null {
  const envs = settings.environments;
  if (!isRecord(envs)) return null;
  for (const [env, value] of Object.entries(envs)) {
    const adapters = isRecord(value) && isRecord(value.adapters) ? value.adapters : {};
    for (const [name, adapter] of Object.entries(adapters)) {
      if ((name === 'login-apple' || name === 'login-google') && adapter !== null) return `environments.${env}.adapters.${name}`;
    }
  }
  return null;
}

function setFirst(map: Map<string, string>, key: string, where: string): void {
  if (!map.has(key)) map.set(key, where);
}

function busMember(arg: Expr | undefined): string | null {
  const text = arg ? chainText(arg) : null;
  return text === null ? null : (BUS_ELEMENT.exec(text)?.[1] ?? null);
}

/** Records one call of client content code. */
function scanCall(scan: CodeScan, call: Extract<Expr, { k: 'call' }>, where: string): void {
  const chain = chainText(call.callee);
  if (chain === null) return;
  scan.called.add(chain);
  setFirst(scan.firstCall, chain, where);
  if (chain === 'SoundCore.play_bgm') setFirst(scan.played, 'BGM', where);
  if (chain === 'AccessibilityCore.play_voice') setFirst(scan.played, 'VOICE', where);
  if (POSITIONAL_NEW.has(chain)) setFirst(scan.played, 'SFX', where);
  const index = BUS_ARG[chain];
  if (index === undefined) return;
  const bus = busMember(call.args[index]);
  if (bus === null) scan.badBus.push(finding(NAME, where, `the \`SoundBus\` argument of \`${chain}\` is not a \`SoundCore.SoundBus\` element`));
  else if (chain !== 'SoundCore.play') scan.called.add(`${chain} ${bus}`);
  else if (PLAY_BUSES.has(bus)) setFirst(scan.played, bus, where);
}

async function scanCode(sc: StaticContext): Promise<CodeScan> {
  const scan: CodeScan = { called: new Set(), firstCall: new Map(), played: new Map(), badBus: [] };
  scan.played.set('UI', at('client/features', 1));
  for (const path of sc.filter((p) => isClientContentGd(p) && !isClientDev(p) && !isClientTest(p))) {
    for (const { call } of callsOf(await sc.gd(path))) scanCall(scan, call, at(path, call.line));
  }
  for (const path of sceneFiles(sc)) {
    const node = (await sc.scene(path)).nodes.find((n) => n.type !== null && POSITIONAL_PLAYERS.has(n.type));
    if (node) setFirst(scan.played, 'SFX', at(path, node.line));
  }
  const cutscene = await sc.table('data/tables/cutscene_step.csv');
  const voiced = cutscene?.rows.find((row) => !['', 'null'].includes(cellOf(cutscene, row, 'voice') ?? ''));
  if (cutscene && voiced) setFirst(scan.played, 'VOICE', at(cutscene.path, voiced.line));
  return scan;
}

const chains = (list: readonly string[]): Need[] => list.map((chain) => ({ chain }));

async function requirements(sc: StaticContext, scan: CodeScan): Promise<Requirement[]> {
  const settings = await sc.settings();
  const text = await sc.text('settings.json');
  const value = (path: string): string => at('settings.json', settingsLine(text, path));
  const req: Requirement[] = [{ needs: chains(ALWAYS), where: at('client/features', 1) }];
  const social = socialLogin(settings);
  if (social !== null) req.push({ needs: chains(['AuthCore.list_linked_providers', 'AuthCore.link_account', 'AuthCore.switch_account']), where: value(social) });
  const consent = settings.consent as { privacyChoices?: unknown } | undefined;
  if (consent?.privacyChoices === true) req.push({ needs: chains(['AuthCore.open_privacy_choices']), where: value('consent.privacyChoices') });
  if ((await sc.modules()).client.includes('AdCore')) req.push({ needs: chains(['AdCore.is_ad_privacy_options_required', 'AdCore.open_ad_privacy_options']), where: value('coreModules') });
  const push = settings.pushConsent as { adPush?: unknown } | undefined;
  if (push?.adPush === true) req.push({ needs: chains(['PushCore.get_push_consent', 'PushCore.set_push_consent']), where: value('pushConsent.adPush') });
  req.push(...(await iapRequirements(sc, settings)));
  req.push(...(await standardRequirements(sc, scan, settings, value)));
  return req;
}

/**
 * The entries of the standard options: language, screen mode, volume, haptics, accessibility, bindings, and the
 * `AccessibilityCore` part of `reset`. The `SoundCore` part of `reset` is an entry every game has.
 */
async function standardRequirements(sc: StaticContext, scan: CodeScan, settings: Record<string, unknown>, value: (path: string) => string): Promise<Requirement[]> {
  const req: Requirement[] = [];
  const languages = Array.isArray(settings.supportedLanguages) ? (settings.supportedLanguages as unknown[]) : [];
  if (languages.length >= 2) req.push({ needs: chains(LANGUAGE), where: value('supportedLanguages') });
  const platforms = Array.isArray(settings.buildPlatforms) ? (settings.buildPlatforms as unknown[]) : [];
  if (SCREEN_MODE_PLATFORMS.some((p) => platforms.includes(p))) req.push({ needs: chains(SCREEN_MODE), where: value('buildPlatforms') });
  for (const [bus, where] of scan.played) req.push({ needs: [{ chain: 'SoundCore.get_volume', bus }, { chain: 'SoundCore.set_volume', bus }], where });
  for (const [chain, needs] of CALL_ENTRIES) {
    const where = scan.firstCall.get(chain);
    if (where !== undefined) req.push({ needs: chains(needs), where });
  }
  if ((await sc.modules()).client.includes('AccessibilityCore')) {
    req.push({ needs: chains(['AccessibilityCore.reset_settings']), where: value('coreModules') });
    const scales = (await sc.coreSettings())['AccessibilityCore.textScales'];
    if (Array.isArray(scales) && scales.length >= 2) req.push({ needs: chains(TEXT_SCALE), where: value('core.AccessibilityCore.textScales') });
  }
  const actions = (await inputMapActions(sc)).filter((a) => !CORE_ACTIONS.includes(a.name));
  const keyAction = actions.find((a) => a.keys);
  if (keyAction && KEYBOARD_PLATFORMS.some((p) => platforms.includes(p))) req.push({ needs: chains(KEY_BINDINGS), where: at(PROJECT_FILE, keyAction.line) });
  const padAction = actions.find((a) => a.pad);
  if (padAction && settings.gamepadSupported === true) req.push({ needs: chains(PAD_BINDINGS), where: at(PROJECT_FILE, padAction.line) });
  return req;
}

async function iapRequirements(sc: StaticContext, settings: Record<string, unknown>): Promise<Requirement[]> {
  const iap = await sc.table('data/tables/iap_product.csv');
  if (!iap) return [];
  const platforms = Array.isArray(settings.buildPlatforms) ? (settings.buildPlatforms as unknown[]) : [];
  const apple = platforms.includes('ios') || platforms.includes('macos');
  const req: Requirement[] = [];
  for (const row of iap.rows) {
    const type = cellOf(iap, row, 'type');
    const owned = type === 'NonConsumable' || type === 'Subscription';
    if (apple && owned && (cellOf(iap, row, 'sku_apple') ?? '') !== '') req.push({ needs: chains(['PaymentCore.restore_purchases']), where: at(iap.path, row.line) });
    if (type === 'Subscription') req.push({ needs: chains(['PaymentCore.open_subscription_management']), where: at(iap.path, row.line) });
  }
  return req;
}

function missingText(need: Need): string {
  const call = need.bus === undefined ? `\`${need.chain}\` call` : `\`${need.chain}\` call with \`SoundCore.SoundBus.${need.bus}\``;
  return `no ${call} in client content code`;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const scan = await scanCode(sc);
  const used = new Set((await sc.modules()).client);
  const out: Finding[] = [...scan.badBus];
  const reportedModules = new Set<string>();
  const reportedCalls = new Set<string>();
  for (const req of await requirements(sc, scan)) {
    for (const need of req.needs) {
      const module = need.chain.slice(0, need.chain.indexOf('.'));
      if (!used.has(module) && !reportedModules.has(module)) {
        reportedModules.add(module);
        out.push(absence(NAME, req.where, `\`${module}\` (for \`${need.chain}\`) is not a module the game uses`));
      }
      const key = needKey(need);
      if (scan.called.has(key) || reportedCalls.has(key)) continue;
      reportedCalls.add(key);
      out.push(absence(NAME, req.where, missingText(need)));
    }
  }
  return out;
}
