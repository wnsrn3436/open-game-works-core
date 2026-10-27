import { expectPositionals, positional, str, type CommandDef } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { LIMITS } from '../../lib/limits.ts';
import { runBaseline } from './lib/baseline.ts';
import { evaluate } from './lib/evaluate.ts';
import { gateOf, type CheckFile } from './lib/files.ts';
import { gameSettings, iterationKind, memorableMomentAsked, openTarget, readRunJson, runRel } from './lib/run.ts';
import { readJudgeMoments, requireReference } from './lib/setup.ts';

const USAGE = 'ogw loop evaluate <game> [--db postgresql]';

export const loopEvaluate: CommandDef = {
  name: ['loop', 'evaluate'],
  usage: USAGE,
  options: { db: { type: 'string' } },
  background: {
    game: (args) => args.positionals[0] ?? null,
    timeLimitMs: () => LIMITS.jobMs,
  },
  async run(ctx, args) {
    expectPositionals(args, 1, 1, USAGE);
    const db = str(args, 'db');
    if (db !== undefined && db !== 'postgresql') throw new OgwError(`usage: ${USAGE}`);
    const { game, run } = await openTarget(ctx, positional(args, 0, 'game'));
    const n = String(run.iteration);
    const check = await readRunJson<CheckFile>(game, run, `check-${n}.json`);
    if (!check) throw new OgwError(`${runRel(run, `check-${n}.json`)} is missing; run ogw check --loop first`);
    const gate = gateOf(check);
    if (gate === null) throw new OgwError(`${runRel(run, `check-${n}.json`)} has no gate`);
    if (gate !== 'pass') throw new OgwError(`${runRel(run, `check-${n}.json`)} gate is not pass`);
    const reference = await requireReference(game);
    const platforms = (await gameSettings(ctx, game)).buildPlatforms ?? [];
    if (platforms.length === 0) throw new OgwError('game settings buildPlatforms is empty');
    const settings = await ctx.settings();
    const kind = iterationKind(run, run.iteration);
    const { file, path } = await evaluate(ctx, {
      game,
      run,
      check,
      commit: check.commit,
      baseline: await runBaseline(game, run),
      // a fun iteration starts no save fixture instance: the judge moments are judged in completeness iterations
      moments: run.kind === 'loop' && kind === 'completeness' ? await readJudgeMoments(game, runRel(run, 'request.md')) : [],
      reference,
      kind,
      platforms,
      settings,
      db,
      memorableMoment: run.kind === 'loop' && memorableMomentAsked(run),
    });
    const lines = [
      path,
      `kind ${file.kind}`,
      ...file.judges.map((j) => `judge ${j.kind} ${j.status} ${j.agent.cli} ${j.agent.model} ${j.agent.effort} side ${j.instanceSide} vs reference ${j.vsReference ?? 'none'}`),
      ...(file.votes ?? []).map((v) => `votes ${v.element}: this ${String(v.this)} baseline ${String(v.baseline)} ${v.decision}`),
      `vs baseline ${file.vsBaseline ?? 'none'}`,
      `vs reference ${file.vsReference ?? 'none'}`,
      ...file.plays.map((p) => `play ${p.status} ${p.result}`),
      `measure ${file.measure ?? 'none'}`,
    ];
    return { text: lines.join('\n'), data: { path, ...file } };
  },
};
