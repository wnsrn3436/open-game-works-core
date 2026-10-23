import { join } from 'node:path';
import { writeFileAtomic } from '../../../lib/fsx.ts';
import type { GameSettings } from '../../../lib/settings.ts';
import type { Env } from './names.ts';
import { chosenAdapterNames, type CollectedDataRow, type CoreSpecModule } from './settingschecks.ts';

/** `build` `## store privacy disclosure` data type mapping: App Store, NSPrivacyCollectedDataType, Google Play. */
export const DATA_TYPES: Record<string, readonly [string, string, string]> = {
  user_id: ['User ID', 'NSPrivacyCollectedDataTypeUserID', 'Personal info: User IDs'],
  device_id: ['Device ID', 'NSPrivacyCollectedDataTypeDeviceID', 'Device or other IDs'],
  nickname: ['Other User Content', 'NSPrivacyCollectedDataTypeOtherUserContent', 'Personal info: Name'],
  purchase_history: ['Purchase History', 'NSPrivacyCollectedDataTypePurchaseHistory', 'Financial info: Purchase history'],
  product_interaction: ['Product Interaction', 'NSPrivacyCollectedDataTypeProductInteraction', 'App activity: App interactions'],
  gameplay_content: ['Gameplay Content', 'NSPrivacyCollectedDataTypeGameplayContent', 'App activity: Other actions'],
  in_app_messages: ['Other User Content', 'NSPrivacyCollectedDataTypeOtherUserContent', 'Messages: Other in-app messages'],
  other_user_content: ['Other User Content', 'NSPrivacyCollectedDataTypeOtherUserContent', 'App activity: Other user-generated content'],
  crash_data: ['Crash Data', 'NSPrivacyCollectedDataTypeCrashData', 'App info and performance: Crash logs'],
  performance_data: ['Performance Data', 'NSPrivacyCollectedDataTypePerformanceData', 'App info and performance: Diagnostics'],
  advertising_data: ['Advertising Data', 'NSPrivacyCollectedDataTypeAdvertisingData', 'App activity: App interactions'],
  coarse_location: ['Coarse Location', 'NSPrivacyCollectedDataTypeCoarseLocation', 'Location: Approximate location'],
  other_data: ['Other Data Types', 'NSPrivacyCollectedDataTypeOtherDataTypes', 'Personal info: Other info'],
};

/** Purpose mapping: App Store, NSPrivacyCollectedDataTypePurposes value, Google Play. */
export const PURPOSES: Record<string, readonly [string, string, string]> = {
  app_functionality: ['App Functionality', 'NSPrivacyCollectedDataTypePurposeAppFunctionality', 'App functionality'],
  account_management: ['App Functionality', 'NSPrivacyCollectedDataTypePurposeAppFunctionality', 'Account management'],
  analytics: ['Analytics', 'NSPrivacyCollectedDataTypePurposeAnalytics', 'Analytics'],
  product_personalization: ['Product Personalization', 'NSPrivacyCollectedDataTypePurposeProductPersonalization', 'Personalization'],
  developer_communications: ['App Functionality', 'NSPrivacyCollectedDataTypePurposeAppFunctionality', 'Developer communications'],
  developer_advertising: ["Developer's Advertising or Marketing", 'NSPrivacyCollectedDataTypePurposeDeveloperAdvertising', 'Advertising or marketing'],
  third_party_advertising: ['Third-Party Advertising', 'NSPrivacyCollectedDataTypePurposeThirdPartyAdvertising', 'Advertising or marketing'],
  fraud_prevention: ['App Functionality', 'NSPrivacyCollectedDataTypePurposeAppFunctionality', 'Fraud prevention, security, and compliance'],
};

export type Declaration = Omit<CollectedDataRow, 'source' | 'condition'> & { source: string };

function valueAt(settings: GameSettings, path: string): unknown {
  let value: unknown = settings;
  for (const part of path.split('.')) {
    if (typeof value !== 'object' || value === null) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

/** The declaration rows of the build (`build` `## store privacy disclosure`). */
export function declarations(settings: GameSettings, env: Env, modules: readonly CoreSpecModule[]): Declaration[] {
  const adapters = new Set(chosenAdapterNames(settings, env));
  const rows: Declaration[] = [];
  for (const module of modules) {
    for (const row of module.collectedData) {
      if (row.dataType === 'none') continue;
      if (row.source !== 'module' && !adapters.has(row.source)) continue;
      if (row.condition !== null && JSON.stringify(valueAt(settings, row.condition.path)) !== JSON.stringify(row.condition.value)) continue;
      rows.push({
        dataType: row.dataType, description: row.description, source: row.source, purposes: row.purposes,
        linked: row.linked, tracking: row.tracking, shared: row.shared, optional: row.optional, platforms: row.platforms,
      });
    }
  }
  const content = ((settings.privacy as { contentData?: Omit<Declaration, 'source'>[] } | undefined)?.contentData ?? []);
  for (const row of content) rows.push({ ...row, source: 'game settings privacy.contentData' });
  return rows;
}

export interface StoreAnswer {
  type: string;
  linked: boolean;
  tracking: boolean;
  shared: boolean;
  optional: boolean;
  purposes: string[];
  rows: Declaration[];
}

/** Store data type answers; `column` picks App Store (0), NSPrivacy (1) or Google Play (2) names. */
export function answers(rows: readonly Declaration[], column: 0 | 1 | 2, trackingAllowed: boolean): StoreAnswer[] {
  const byType = new Map<string, StoreAnswer>();
  for (const row of rows) {
    const type = (DATA_TYPES[row.dataType] as readonly [string, string, string])[column];
    const answer = byType.get(type) ?? { type, linked: false, tracking: false, shared: false, optional: true, purposes: [], rows: [] };
    answer.linked ||= row.linked;
    answer.tracking ||= trackingAllowed && row.tracking;
    answer.shared ||= row.shared;
    answer.optional &&= row.optional;
    for (const purpose of row.purposes) {
      const mapped = (PURPOSES[purpose] as readonly [string, string, string])[column];
      if (!answer.purposes.includes(mapped)) answer.purposes.push(mapped);
    }
    answer.rows.push(row);
    byType.set(type, answer);
  }
  return [...byType.values()];
}

const NO_DATA = 'No data is collected.';

function draft(title: string, list: StoreAnswer[], extra: string[]): string {
  const lines = [`# ${title}`, ''];
  if (list.length === 0) lines.push(NO_DATA, '');
  for (const a of list) {
    lines.push(`## ${a.type}`, '');
    lines.push(`- linked: ${String(a.linked)}`, `- tracking: ${String(a.tracking)}`, `- shared: ${String(a.shared)}`, `- optional: ${String(a.optional)}`);
    lines.push(`- purposes: ${a.purposes.join(', ')}`, '- evidence:');
    for (const row of a.rows) lines.push(`  - ${row.description} (${row.source})`);
    lines.push('');
  }
  return `${[...lines, ...extra].join('\n').trimEnd()}\n`;
}

const bool = (value: boolean): string => (value ? '<true/>' : '<false/>');

export function privacyManifest(list: readonly StoreAnswer[]): string {
  const items = list.map((a) =>
    [
      '\t\t<dict>',
      '\t\t\t<key>NSPrivacyCollectedDataType</key>',
      `\t\t\t<string>${a.type}</string>`,
      '\t\t\t<key>NSPrivacyCollectedDataTypeLinked</key>',
      `\t\t\t${bool(a.linked)}`,
      '\t\t\t<key>NSPrivacyCollectedDataTypeTracking</key>',
      `\t\t\t${bool(a.tracking)}`,
      '\t\t\t<key>NSPrivacyCollectedDataTypePurposes</key>',
      '\t\t\t<array>',
      ...a.purposes.map((p) => `\t\t\t\t<string>${p}</string>`),
      '\t\t\t</array>',
      '\t\t</dict>',
    ].join('\n'),
  );
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>NSPrivacyTracking</key>',
    `\t${bool(list.some((a) => a.tracking))}`,
    '\t<key>NSPrivacyTrackingDomains</key>',
    '\t<array/>',
    '\t<key>NSPrivacyCollectedDataTypes</key>',
    '\t<array>',
    ...items,
    '\t</array>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
}

export interface PrivacyInput {
  dir: string;
  env: Env;
  platforms: string[];
  settings: GameSettings;
  modules: CoreSpecModule[];
}

/** Writes `builds/<env>-<version>/privacy/` and returns the written file names. */
export async function writePrivacy(input: PrivacyInput): Promise<{ files: string[]; ios: StoreAnswer[] }> {
  const rows = declarations(input.settings, input.env, input.modules);
  const tracking = (input.settings.consent as { trackingRequest?: boolean } | undefined)?.trackingRequest === true;
  const on = (platforms: string[]): Declaration[] => rows.filter((r) => r.platforms.some((p) => platforms.includes(p)));
  const files: string[] = [];
  const ios = answers(on(['ios']), 1, tracking);
  if (input.platforms.includes('ios')) {
    await writeFileAtomic(join(input.dir, 'PrivacyInfo.xcprivacy'), privacyManifest(ios));
    files.push('PrivacyInfo.xcprivacy');
  }
  if (input.platforms.some((p) => p === 'ios' || p === 'macos')) {
    await writeFileAtomic(join(input.dir, 'app-store.md'), draft('App Store Connect App Privacy', answers(on(['ios', 'macos']), 0, tracking), []));
    files.push('app-store.md');
  }
  if (input.platforms.includes('android')) {
    const prod = input.settings.environments?.PROD?.serverUrl;
    const extra = [
      '## other answers',
      '',
      '- encrypted in transit: Yes',
      '- users can request that data be deleted: Yes',
      `- account deletion URL: ${typeof prod === 'string' ? prod : ''}/account/deletion`,
    ];
    await writeFileAtomic(join(input.dir, 'google-play.md'), draft('Google Play Console Data safety', answers(on(['android']), 2, true), extra));
    files.push('google-play.md');
  }
  return { files, ios };
}
