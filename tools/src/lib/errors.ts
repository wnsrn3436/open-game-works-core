/** An expected failure. The CLI prints `message` and ends with `exitCode`. */
export class OgwError extends Error {
  readonly exitCode: number;
  readonly data: unknown;

  constructor(message: string, exitCode = 1, data?: unknown) {
    super(message);
    this.name = 'OgwError';
    this.exitCode = exitCode;
    this.data = data;
  }
}

/** Exit code used only by `job wait`, `agent wait`, `review wait` on timeout. */
export const EXIT_STILL_RUNNING = 75;

export function fail(message: string, data?: unknown): never {
  throw new OgwError(message, 1, data);
}

/** Body of a cross-group API function whose owner has not built it yet. */
export function notBuilt(name: string): Promise<never> {
  return Promise.reject(new OgwError(`${name}: not built yet`));
}
