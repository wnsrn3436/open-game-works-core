import { expectPositionals, nonNegativeInt, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { LIMITS } from '../../lib/limits.ts';
import { startInstance } from './api.ts';
import { START_LIMIT_MS } from './lib/supervisor.ts';

export const start: CommandDef = {
  name: ['instance', 'start'],
  usage: 'ogw instance start <game> [--commit <sha>] [--platform <platform>] [--fixture <file>] [--db postgresql] [--input-latency <ms>]',
  options: {
    commit: { type: 'string' },
    platform: { type: 'string' },
    fixture: { type: 'string' },
    db: { type: 'string' },
    'input-latency': { type: 'string' },
  },
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: (_args, settings) => settings.instanceWaitTimeoutMs + START_LIMIT_MS + LIMITS.programMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const db = str(args, 'db');
    if (db !== undefined && db !== 'postgresql') throw new OgwError(`invalid --db: ${db}`);
    const inputLatencyMs = nonNegativeInt(args, 'input-latency');
    const info = await startInstance(ctx, {
      game: positional(args, 0, 'game'),
      commit: str(args, 'commit'),
      platform: str(args, 'platform'),
      fixture: str(args, 'fixture'),
      db,
      ...(inputLatencyMs === undefined ? {} : { inputLatencyMs }),
    });
    return {
      text: [`id: ${info.id}`, `address: ${info.serverUrl}`].join('\n'),
      data: { id: info.id, address: info.serverUrl, commit: info.commit, platform: info.platform },
    };
  },
};
