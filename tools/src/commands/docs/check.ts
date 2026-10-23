import { expectPositionals, type CommandDef } from '../../lib/command.ts';
import { buildFromHarness } from '../core/lib/spec-build.ts';
import { listDocs, type DocFile, type Failure } from './lib/files.ts';
import { checkHumanPrep, checkNativeAgents, checkSchema } from './lib/misc-items.ts';
import {
  checkAdminOperation,
  checkCoreErrorOwner,
  checkOnceKeyPrefix,
  checkSettingsTable,
  checkSpecDevTable,
  checkSpecHeading,
  checkTestingDev,
  specHeadings,
  type SpecDoc,
} from './lib/spec-items.ts';
import { checkSpecReference } from './lib/spec-reference.ts';
import { checkEnglish, checkReferences, checkSize, checkTerms, checkWriting } from './lib/text-items.ts';

/** The items of the harness consistency check, in report order. */
export const ITEMS: readonly string[] = [
  'terms',
  'references',
  'writing',
  'English',
  'size',
  'settings table',
  'schema',
  'spec heading',
  'spec DEV table',
  'spec reference',
  'native agents',
  'core spec',
  'core error owner',
  'once_key prefix',
  'testing DEV operation',
  'admin operation',
  'human prep',
];

function missing(item: string, rel: string): Failure[] {
  return [{ item, where: rel, reason: 'file not found' }];
}

/** Items that need the parsed module specs; they do not run when `core spec` cannot parse them. */
export const SPEC_ITEMS: readonly string[] = [
  'settings table',
  'spec heading',
  'spec DEV table',
  'spec reference',
  'core error owner',
  'once_key prefix',
  'testing DEV operation',
  'admin operation',
];

/** An item that did not run, with the reason. */
export interface Skipped {
  item: string;
  reason: string;
}

export interface DocsCheck {
  failures: Failure[];
  skipped: Skipped[];
}

async function specChecks(harness: string, docs: ReadonlyMap<string, DocFile>): Promise<DocsCheck> {
  let core: Awaited<ReturnType<typeof buildFromHarness>>;
  try {
    core = await buildFromHarness(harness);
  } catch (error) {
    // The items that need the parsed specs do not run; the other items still run.
    return {
      failures: [{ item: 'core spec', where: '', reason: error instanceof Error ? error.message : String(error) }],
      skipped: SPEC_ITEMS.map((item) => ({ item, reason: 'not run: the module specs could not be parsed (see core spec)' })),
    };
  }
  const failures: Failure[] = core.errors.map((line) => {
    const m = /^(.+?:\d+): (.*)$/.exec(line);
    return { item: 'core spec', where: m ? (m[1] as string) : '', reason: m ? (m[2] as string) : line };
  });
  const specs: SpecDoc[] = core.specs.map((parsed) => ({
    entry: parsed.entry,
    lines: docs.get(parsed.entry.specRel)?.lines ?? [],
    parsed,
  }));
  const coreSkill = docs.get('skills/core/SKILL.md');
  const headings = coreSkill ? specHeadings(coreSkill) : null;
  const baseProto = docs.get('skills/server-core/base-proto.md');
  failures.push(
    ...checkSettingsTable(specs),
    ...(headings ? checkSpecHeading(specs, headings) : [{ item: 'spec heading', where: 'skills/core/SKILL.md', reason: 'no ## spec heading table' }]),
    ...checkSpecDevTable(specs),
    ...checkSpecReference(specs),
    ...(baseProto ? checkCoreErrorOwner(baseProto, specs) : missing('core error owner', 'skills/server-core/base-proto.md')),
    ...checkOnceKeyPrefix(specs),
    ...checkTestingDev(specs),
    ...checkAdminOperation(specs),
  );
  return { failures, skipped: [] };
}

/** Runs every harness consistency check item on the harness working tree; `skipped` are the items that could not run. */
export async function runDocsCheck(harness: string): Promise<DocsCheck> {
  const list = await listDocs(harness);
  const docs = new Map(list.map((d) => [d.rel, d]));
  const spec = await specChecks(harness, docs);
  const failures: Failure[] = [
    ...checkTerms(list),
    ...checkReferences(harness, list),
    ...checkWriting(list),
    ...checkEnglish(list),
    ...checkSize(list),
    ...(await checkSchema(harness)),
    ...checkNativeAgents(harness),
    ...spec.failures,
    ...checkHumanPrep(docs.get('skills/build/SKILL.md')),
  ];
  const order = new Map(ITEMS.map((item, i) => [item, i]));
  const sorted = failures
    .map((f, i) => ({ f, i }))
    .sort((a, b) => (order.get(a.f.item) ?? 0) - (order.get(b.f.item) ?? 0) || a.i - b.i)
    .map(({ f }) => f);
  return { failures: sorted, skipped: spec.skipped };
}

export function failureLine(f: Failure): string {
  return f.where === '' ? `${f.item}: ${f.reason}` : `${f.item}: ${f.where}: ${f.reason}`;
}

export const check: CommandDef = {
  name: ['docs', 'check'],
  usage: 'ogw docs check',
  async run(ctx, args) {
    expectPositionals(args, 0, 0, this.usage);
    const ws = await ctx.workspace();
    const { failures, skipped } = await runDocsCheck(ws.harness);
    const failed = new Set(failures.map((f) => f.item));
    const notRun = new Map(skipped.map((s) => [s.item, s.reason]));
    const items = ITEMS.map((name) => {
      if (failed.has(name)) return { name, result: 'fail' };
      const reason = notRun.get(name);
      return reason === undefined ? { name, result: 'pass' } : { name, result: 'unknown', reason };
    });
    if (failures.length === 0 && skipped.length === 0) {
      return { text: `docs check: ${String(ITEMS.length)} items pass`, data: { ok: true, items, failures } };
    }
    const text = [...failures.map(failureLine), ...skipped.map((s) => `${s.item}: ${s.reason}`)].join('\n');
    return { exitCode: 1, text, data: { ok: false, items, failures } };
  },
};
