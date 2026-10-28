import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as formatArgs from '../../../../src/commands/check/static/format-args.ts';
import { lastProdTagName } from '../../../../src/commands/build/lib/names.ts';
import * as owner from '../../../../src/commands/check/static/game-settings-owner.ts';
import { StaticContext } from '../../../../src/commands/check/static/lib/context.ts';
import { acceptedKinds, formatArgs as parseFormatArgs } from '../../../../src/commands/check/static/lib/format.ts';
import type { GameRepo } from '../../../../src/lib/game.ts';
import { changeRuns, newRunState } from '../../../../src/lib/runstate.ts';
import { commitAll, gitInit, sh } from '../../../helpers/workspace.ts';
import { lines, memContext, sorted, testContext, writeFiles } from './helpers.ts';

const state = vi.hoisted(() => ({ errors: [] as string[], releaseDir: '' }));

vi.mock('../../../../src/commands/settings/api.ts', async () => ({
  gameCheckErrors: () => Promise.resolve(state.errors),
  gameSettingsValue: (await vi.importActual<typeof import('../../../../src/commands/settings/lib/game-check.ts')>('../../../../src/commands/settings/lib/game-check.ts')).gameSettingsValue,
}));

vi.mock('../../../../src/commands/core/api.ts', () => ({
  coreReleaseOfGame: () => Promise.resolve({ version: '1.0.0', dir: state.releaseDir, local: false }),
}));

describe('format', () => {
  it('reads format arguments and formatter value kinds', () => {
    expect(parseFormatArgs('{count} x {name:이/가} {action:jump} {when:date} {a:plural:one/many}')).toEqual([
      { name: 'count', formatter: null },
      { name: 'name', formatter: '이/가' },
      { name: 'when', formatter: 'date' },
      { name: 'a', formatter: 'plural:one/many' },
    ]);
    expect([...acceptedKinds(null)]).toEqual(['integer', 'real', 'string']);
    expect([...acceptedKinds('n')]).toEqual(['integer', 'real']);
    expect([...acceptedKinds('compact')]).toEqual(['integer', 'string']);
    expect([...acceptedKinds('plural:a/b')]).toEqual(['integer', 'real']);
    expect([...acceptedKinds('ordinal')]).toEqual(['integer']);
    expect([...acceptedKinds('duration')]).toEqual(['integer']);
    expect([...acceptedKinds('을/를')]).toEqual(['integer', 'real', 'string']);
    expect([...acceptedKinds('weird')]).toEqual([]);
  });
});

describe('format args', () => {
  const data = {
    'data/system/reserved_id.csv': ',,\nAll,None,All\nid(key),string,string\nid,target,value\n[welcome_push],Server,[push_welcome]\n[gift_mail],Server,[mail_gift]\n[empty],Server,\n',
    'data/tables/push_message.csv': ',,,\nAll,All,All,All\nid(key),tstring<id>,tstring<id>,enum<PushKind>\nid,title,body,kind\n[push_welcome],Hi {name},You have {count:n} gems,Info\n',
    'data/tables/mail_template.csv': ',,\nAll,All,All\nid(key),tstring<id>,tstring<id>\nid,title,body\n[mail_gift],Gift,{count:compact} gold for {rank:ordinal}\n',
    'data/translations/en.csv': 'key,source,source_hash,current_hash,text\nmail_template.body.[mail_gift],x,1,1,{count} gold for {rank:duration}\npush_message.title.[push_welcome],x,1,1,\n',
    'data/translations/ko.csv': 'key,source,source_hash,current_hash,text\nmail_template.body.[mail_gift],x,1,1,{count:n} 골드 {rank:ordinal}\n',
  };

  it('checks names and value kinds of reserved message and mail template args', async () => {
    const sc = memContext({
      ...data,
      'server/handlers/Login.ts': [
        "core.push.queue_push(ctx, user, ReservedId.welcome_push(), [{ name: 'name', value: { text_value: 'a' } }, { name: 'count', value: { int_value: 5n } }], 0n, '');",
        "core.push.queue_push(ctx, user, ReservedId.welcome_push(), [{ name: 'name', text_value: 'a' }, { name: 'count', text_value: 'x' }], 0n, '');",
        "core.push.queue_push(ctx, user, ReservedId.welcome_push(), [{ name: 'name', value: { text_value: 'a' } }], 0n, '');",
        "core.push.queue_push(ctx, user, ReservedId.welcome_push(), [{ name: key, value: { text_value: 'a' } }, 5], 0n, '');",
        "core.mailbox.send_mail(ctx, { template_id: ReservedId.gift_mail(), args: [{ name: 'count', kind: MailArgKind.Text, text_value: '1' }, { name: 'rank', kind: MailArgKind.Int, int_value: 1n }] });",
        "core.mailbox.grant_or_mail(ctx, items, source, GameData.ReservedId.gift_mail(), [{ name: 'count', int_value: 3n }, { name: 'rank', int_value: 1n }]);",
        "core.mailbox.grant_or_mail(ctx, items, source, templateId, [{ name: 'zzz', int_value: 3n }]);",
        "core.mailbox.grant_or_mail(ctx, items, source, ReservedId.gift_mail(), args);",
        "core.mailbox.grant_or_mail(ctx, items, source, ReservedId.empty(), [{ name: 'q', int_value: 1n }]);",
        '',
      ].join('\n'),
      'server/core/x.ts': "core.push.queue_push(ctx, user, ReservedId.welcome_push(), [], 0n, '');\n",
    });
    expect(lines(await formatArgs.run(sc))).toEqual(sorted([
      'server/handlers/Login.ts:2 | format args: formatter `n` of `{count}` does not take a string value',
      'server/handlers/Login.ts:3 | format args: `args` names {name} differ from the format arguments {count, name} of the `push_message` row of `[welcome_push]`',
      'server/handlers/Login.ts:4 | format args: `args` element `name` is not a string literal',
      'server/handlers/Login.ts:4 | format args: `args` element `name` is not a string literal',
      'server/handlers/Login.ts:4 | format args: `args` names {} differ from the format arguments {count, name} of the `push_message` row of `[welcome_push]`',
      'server/handlers/Login.ts:5 | format args: formatter `n` of `{count}` does not take a string value',
    ]));
  });
});

function ownerGame(): { sc: () => Promise<StaticContext>; root: string; game: GameRepo } {
  const root = join(state.releaseDir, '..', 'game');
  gitInit(root);
  const game: GameRepo = { name: 'g', root, mainRoot: root, commonDir: join(root, '.git'), inWorktree: false };
  const sc = async (): Promise<StaticContext> => StaticContext.create(testContext(root), game);
  return { sc, root, game };
}

describe('game settings owner', () => {
  beforeEach(() => {
    const dir = memContext({}).root;
    state.releaseDir = join(dir, 'release');
    mkdirSync(state.releaseDir, { recursive: true });
    writeFileSync(
      join(state.releaseDir, 'core-settings.schema.json'),
      JSON.stringify({ properties: { 'NetworkCore.retryCount': { type: 'integer' }, 'QACore.softlockBlockMs': { type: 'object', 'x-owner': 'human' }, Nested: { properties: { key: { 'x-owner': 'human' } } } } }),
    );
    state.errors = [];
  });

  it('reports game check errors', async () => {
    const { sc, root } = ownerGame();
    writeFiles(root, { 'settings.json': { engine: 'godot' } });
    commitAll(root);
    state.errors = ['/appId required'];
    expect(lines(await owner.run(await sc()))).toEqual(['settings.json:1 | game settings owner: ogw game check: /appId required']);
  });

  it('compares human-owned items and core keys with the run reference commit', async () => {
    const { sc, root, game } = ownerGame();
    const base = { engine: 'godot', appId: 'a', firstScene: 'scene/a', core: { 'NetworkCore.retryCount': 1, 'QACore.softlockBlockMs': { scene: 1 }, Nested: { key: 1 } } };
    writeFiles(root, { 'settings.json': base });
    const reference = commitAll(root);
    const changed = { ...base, appId: 'b', firstScene: 'scene/b', core: { 'NetworkCore.retryCount': 2, 'QACore.softlockBlockMs': { scene: 2 }, Nested: { key: 2 } } };
    writeFiles(root, { 'settings.json': changed });
    expect(await owner.run(await sc())).toEqual([]);
    await changeRuns(game, (runs) => {
      runs.push(newRunState({ name: 'r1', kind: 'loop', branch: 'loop/r1', baseCommit: reference, referenceCommit: null }));
    });
    expect(await owner.run(await sc())).toEqual([]);
    await changeRuns(game, (runs) => {
      (runs[0] as { referenceCommit: string | null }).referenceCommit = reference;
    });
    const text = JSON.stringify(changed, null, 2).split('\n');
    const line = (key: string): number => text.findIndex((l) => l.includes(`"${key}"`)) + 1;
    expect(lines(await owner.run(await sc()))).toEqual(sorted([
      `settings.json:${String(line('appId'))} | game settings owner: \`appId\` is not a content item and differs from the run reference commit ${reference}`,
      `settings.json:${String(line('QACore.softlockBlockMs'))} | game settings owner: core settings key \`QACore.softlockBlockMs\` is owned by human and differs from the run reference commit ${reference}`,
      `settings.json:${String(line('key'))} | game settings owner: core settings key \`Nested.key\` is owned by human and differs from the run reference commit ${reference}`,
    ]));
  });

  it('compares the values at the reference commit humanDecided paths with the run reference commit', async () => {
    const { sc, root, game } = ownerGame();
    const base = { engine: 'godot', firstScene: 'scene/a', titleScene: 'scene/t', core: { 'NetworkCore.retryCount': 1 }, humanDecided: ['firstScene', 'core.NetworkCore.retryCount'] };
    writeFiles(root, { 'settings.json': base });
    const reference = commitAll(root);
    await changeRuns(game, (runs) => {
      runs.push(newRunState({ name: 'r1', kind: 'loop', branch: 'loop/r1', baseCommit: reference, referenceCommit: reference }));
    });
    const content = { ...base, titleScene: 'scene/u' };
    writeFiles(root, { 'settings.json': content });
    expect(await owner.run(await sc())).toEqual([]);
    const changed = { ...base, firstScene: 'scene/b', core: { 'NetworkCore.retryCount': 2 } };
    writeFiles(root, { 'settings.json': changed });
    const text = JSON.stringify(changed, null, 2).split('\n');
    const line = (key: string): number => text.findIndex((l) => l.includes(`"${key}"`)) + 1;
    expect(lines(await owner.run(await sc()))).toEqual(sorted([
      `settings.json:${String(line('firstScene'))} | game settings owner: \`firstScene\` is in humanDecided and differs from the run reference commit ${reference}`,
      `settings.json:${String(line('NetworkCore.retryCount'))} | game settings owner: \`core.NetworkCore.retryCount\` is in humanDecided and differs from the run reference commit ${reference}`,
    ]));
  });

  it('compares PROD-fixed items with the last prod tag, schema defaults filled in', async () => {
    const { sc, root } = ownerGame();
    writeFiles(root, { 'settings.json': { engine: 'godot', nicknameUnique: true } });
    commitAll(root);
    sh(root, 'git', ['tag', 'prod-1.2.0']);
    writeFiles(root, { 'settings.json': { engine: 'godot', nicknameUnique: false, dailyResetOffsetMs: 5 } });
    commitAll(root);
    sh(root, 'git', ['tag', 'prod-1.10.0']);
    sh(root, 'git', ['tag', 'prod-2.0.0-bundle-1']);
    writeFiles(root, { 'settings.json': { engine: 'godot', nicknameUnique: false, dailyResetOffsetMs: 0 } });
    expect(lines(await owner.run(await sc()))).toEqual(['settings.json:4 | game settings owner: `dailyResetOffsetMs` differs from the last PROD build `prod-1.10.0`']);
    writeFiles(root, { 'settings.json': { engine: 'godot', dailyResetOffsetMs: 5 } });
    expect(lines(await owner.run(await sc()))).toEqual(['settings.json:1 | game settings owner: `nicknameUnique` differs from the last PROD build `prod-1.10.0`']);
  });

  it('picks the highest prod version and reads owner schema facts', () => {
    expect(lastProdTagName(['prod-1.9.0', 'prod-1.10.0', 'prod-1.10.0-bundle-2', 'stg-9.0.0'])).toBe('prod-1.10.0');
    expect(lastProdTagName(['dev-1.0.0'])).toBeNull();
    expect(owner.humanItems({ properties: { a: { 'x-owner': 'content' }, b: {}, c: { 'x-owner': 'human' } } })).toEqual(['b', 'c']);
    expect(owner.coreValue({ 'A.b': 1, A: { c: 2 } }, 'A.b')).toBe(1);
    expect(owner.coreValue({ A: { c: 2 } }, 'A.c')).toBe(2);
    expect(owner.coreValue({ A: 3 }, 'A.c')).toBeUndefined();
    expect(owner.coreValue(null, 'A')).toBeUndefined();
  });
});
