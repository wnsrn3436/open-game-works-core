import type { Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { automationRequest } from '../instance/automation.ts';
import { toTelemetry, type Telemetry } from './lib/metrics.ts';

/** Raw `get_telemetry` result of the client that is not a bot client. */
export async function readTelemetryRaw(ctx: Context, instanceId: string): Promise<unknown> {
  const response = await automationRequest(ctx, instanceId, 'get_telemetry', [], 'main', { access: 'play' });
  if (!response.ok) throw new OgwError(`get_telemetry failed: ${JSON.stringify(response.result)}`);
  return response.result;
}

/** `get_telemetry` of the client that is not a bot client. */
export async function readTelemetry(ctx: Context, instanceId: string): Promise<Telemetry> {
  return toTelemetry(await readTelemetryRaw(ctx, instanceId));
}

/** `play ms` of a telemetry at the time `at`: the ms since the telemetry started. */
export function playMs(telemetry: Telemetry, at: number): number {
  return at - telemetry.started_at;
}

/** The four summary lines of a telemetry at the time `now`. */
export function summaryLines(telemetry: Telemetry, now: number): string[] {
  return [
    `- play ms: ${String(playMs(telemetry, now))}`,
    `- scenes: ${telemetry.scene_loads.map((l) => l.scene_key).join(', ')}`,
    `- fail: ${String(telemetry.marks.filter((m) => m.kind === 'Fail').length)}`,
    `- restart: ${String(telemetry.marks.filter((m) => m.kind === 'Restart').length)}`,
  ];
}

/** The four lines of `ogw telemetry <instance> --summary`. */
export async function telemetrySummary(ctx: Context, instanceId: string): Promise<string[]> {
  return summaryLines(await readTelemetry(ctx, instanceId), Date.now());
}
