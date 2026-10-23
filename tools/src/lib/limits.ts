/**
 * Time limits of processes whose limit no harness document or settings value sets.
 * Every process ogw starts has a time limit.
 */
export const LIMITS = {
  /** a `--background` job */
  jobMs: 12 * 60 * 60_000,
  /** a git, docker, engine or other program call made by a command */
  programMs: 60 * 60_000,
  /** a short program call: `ps`, `security`, version probes */
  shortMs: 60_000,
  /** one HTTP request */
  httpMs: 5 * 60_000,
} as const;
