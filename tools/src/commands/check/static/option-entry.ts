import { absence, at, type Finding, type StaticContext } from './lib/context.ts';
import { cellOf } from './lib/csv.ts';
import { isClientContentGd, isClientDev, isClientTest } from './lib/files.ts';
import { callsOf } from './lib/gd-shared.ts';
import { chainText } from './lib/gd-walk.ts';

/**
 * option entry (`client-content` `## core usage`): client content code outside `client/dev/` and `client/tests/` lacks
 * a call the option screen needs. A missing call has no line; `where` points at the setting or data row that makes
 * the call required, or at `client/features` for the calls every game needs.
 */
export const NAME = 'option entry';

const ALWAYS = ['AuthCore.open_terms_document', 'AuthCore.withdraw', 'AuthCore.get_user_id', 'NativeUiCore.copy_text', 'UICore.open_licenses', 'AuthCore.issue_deletion_code'];

interface Requirement {
  calls: string[];
  where: string;
}

/** Line of the first `"<key>"` in the settings text, or 1. */
export function keyLine(text: string, key: string): number {
  const index = text.split('\n').findIndex((l) => l.includes(`"${key}"`));
  return index === -1 ? 1 : index + 1;
}

function socialLogin(settings: Record<string, unknown>): boolean {
  const envs = settings.environments;
  if (typeof envs !== 'object' || envs === null) return false;
  return Object.values(envs as Record<string, unknown>).some((env) => {
    const adapters = (env as { adapters?: Record<string, unknown> } | null)?.adapters ?? {};
    return (adapters['login-apple'] ?? null) !== null || (adapters['login-google'] ?? null) !== null;
  });
}

async function requirements(sc: StaticContext): Promise<Requirement[]> {
  const settings = await sc.settings();
  const text = await sc.text('settings.json');
  const req: Requirement[] = [{ calls: ALWAYS, where: at('client/features', 1) }];
  if (socialLogin(settings)) req.push({ calls: ['AuthCore.list_linked_providers', 'AuthCore.link_account', 'AuthCore.switch_account'], where: at('settings.json', keyLine(text, 'environments')) });
  const consent = settings.consent as { privacyChoices?: unknown } | undefined;
  if (consent?.privacyChoices === true) req.push({ calls: ['AuthCore.open_privacy_choices'], where: at('settings.json', keyLine(text, 'privacyChoices')) });
  if ((await sc.modules()).client.includes('AdCore')) req.push({ calls: ['AdCore.is_ad_privacy_options_required', 'AdCore.open_ad_privacy_options'], where: at('settings.json', keyLine(text, 'coreModules')) });
  const push = settings.pushConsent as { adPush?: unknown } | undefined;
  if (push?.adPush === true) req.push({ calls: ['PushCore.get_push_consent', 'PushCore.set_push_consent'], where: at('settings.json', keyLine(text, 'adPush')) });
  req.push(...(await iapRequirements(sc, settings)));
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
    if (apple && owned && (cellOf(iap, row, 'sku_apple') ?? '') !== '') req.push({ calls: ['PaymentCore.restore_purchases'], where: at(iap.path, row.line) });
    if (type === 'Subscription') req.push({ calls: ['PaymentCore.open_subscription_management'], where: at(iap.path, row.line) });
  }
  return req;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const called = new Set<string>();
  for (const path of sc.filter((p) => isClientContentGd(p) && !isClientDev(p) && !isClientTest(p))) {
    for (const { call } of callsOf(await sc.gd(path))) {
      const chain = chainText(call.callee);
      if (chain !== null) called.add(chain);
    }
  }
  const out: Finding[] = [];
  const reported = new Set<string>();
  for (const req of await requirements(sc)) {
    for (const call of req.calls) {
      if (called.has(call) || reported.has(call)) continue;
      reported.add(call);
      out.push(absence(NAME, req.where, `no \`${call}\` call in client content code`));
    }
  }
  return out;
}
