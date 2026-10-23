import { flag, str, type CommandArgs } from '../../../lib/command.ts';
import { OgwError } from '../../../lib/errors.ts';
import type { AdminTarget } from '../../admin/api.ts';

const INT64_MAX = 9223372036854775807n;

/** A decimal int64 argument, as the decimal string the admin API takes. `positive` requires 1 or more. */
export function int64Arg(value: string, what: string, positive: boolean): string {
  if (!/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) > INT64_MAX || (positive && value === '0')) {
    throw new OgwError(`${what} must be a ${positive ? 'positive' : 'non-negative'} decimal int64: ${value}`);
  }
  return value;
}

/** The clone target environment: DEV or STG. */
export function cloneEnv(value: string): AdminTarget & { env: 'DEV' | 'STG' } {
  if (value !== 'DEV' && value !== 'STG') throw new OgwError(`environment must be DEV or STG: ${value}`);
  return { env: value };
}

/** `--record` is taken only with `--instance`. */
export function recordFlag(args: CommandArgs): boolean {
  const record = flag(args, 'record');
  if (record && str(args, 'instance') === undefined) throw new OgwError('--record is taken only with --instance');
  return record;
}
