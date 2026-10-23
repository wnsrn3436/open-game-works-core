import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { crashReportPid, keepInstanceLogs } from '../../../../src/commands/check/lib/instances.ts';
import { createContext } from '../../../../src/lib/command.ts';

/** An `.ips` crash report: a JSON header line, then a JSON body with the pid. */
function ips(pid: number): string {
  return `{"app_name":"Godot","bug_type":"309"}\n{\n  "pid" : ${String(pid)},\n  "exception" : {"signal" : "SIGABRT"}\n}\n`;
}

describe('crashReportPid', () => {
  it('reads the pid of the body, and null without one', () => {
    expect(crashReportPid(ips(4242))).toBe(4242);
    expect(crashReportPid('{"app_name":"Godot"}\n{}')).toBeNull();
  });
});

describe('keepInstanceLogs', () => {
  it('keeps the log files of the instance folder and the crash reports of its client processes', async () => {
    const base = mkdtempSync(join(tmpdir(), 'ogw-keep-logs-'));
    const instances = join(base, 'instances');
    const folder = join(instances, 'i1');
    mkdirSync(folder, { recursive: true });
    const startedAt = Date.now() - 1000;
    writeFileSync(join(instances, 'i1.json'), JSON.stringify({ id: 'i1', startedAt, pids: { server: 100, main: 200, social: 300 } }));
    writeFileSync(join(folder, 'runner.log'), 'main exited with null\n');
    writeFileSync(join(folder, 'main.log'), 'client\n');
    writeFileSync(join(folder, 'db.sqlite'), 'db');
    const home = join(base, 'home');
    const reports = join(home, 'Library', 'Logs', 'DiagnosticReports');
    mkdirSync(reports, { recursive: true });
    writeFileSync(join(reports, 'Godot-2026-10-20-221204.ips'), ips(200));
    writeFileSync(join(reports, 'Godot-2026-10-20-221205.ips'), ips(300));
    // another instance's client, the server process, a report from before the instance, another app
    writeFileSync(join(reports, 'Godot-2026-10-20-221206.ips'), ips(999));
    writeFileSync(join(reports, 'Godot-2026-10-20-221207.ips'), ips(100));
    writeFileSync(join(reports, 'Godot-old.ips'), ips(200));
    utimesSync(join(reports, 'Godot-old.ips'), new Date(startedAt - 60_000), new Date(startedAt - 60_000));
    writeFileSync(join(reports, 'Other-2026.ips'), ips(200));
    const env = { ...process.env, HOME: home, OGW_INSTANCES_DIR: instances };
    const ctx = createContext({ cwd: base, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    const kept = await keepInstanceLogs(ctx, 'i1', { root: base, dir: 'evidence', relative: true });
    const crash = process.platform === 'darwin'
      ? ['evidence/instance-i1/Godot-2026-10-20-221204.ips', 'evidence/instance-i1/Godot-2026-10-20-221205.ips']
      : [];
    expect(kept).toEqual(['evidence/instance-i1/main.log', 'evidence/instance-i1/runner.log', ...crash]);
    expect(readFileSync(join(base, 'evidence/instance-i1/runner.log'), 'utf8')).toBe('main exited with null\n');
    expect(await keepInstanceLogs(ctx, 'i1', { root: base, dir: null, relative: true })).toEqual([]);
  });
});
