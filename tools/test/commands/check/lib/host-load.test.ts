import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { describe, expect, it } from 'vitest';
import {
  hostProbe,
  parseProcStat,
  parsePs,
  processReading,
  procProcesses,
  psCpuMs,
  treeCpuMs,
  type ProcessCpu,
} from '../../../../src/commands/check/lib/host-load.ts';
import { fakeContext } from '../helpers.ts';

describe('process CPU time of the host', () => {
  it('reads the macOS ps time [[dd-]hh:]mm:ss.cc in ms', () => {
    expect(psCpuMs('0:00.03')).toBe(30);
    expect(psCpuMs('73:17.52')).toBe((73 * 60 + 17) * 1000 + 520);
    expect(psCpuMs('02:03:04.05')).toBe((2 * 3600 + 3 * 60 + 4) * 1000 + 50);
    expect(psCpuMs('1-02:03:04.05')).toBe(((24 + 2) * 3600 + 3 * 60 + 4) * 1000 + 50);
    expect(psCpuMs('12:34')).toBe((12 * 60 + 34) * 1000);
    for (const bad of ['', 'abc', '1:2:3:4', '1.5', '-01:02.03']) expect(psCpuMs(bad)).toBeNull();
  });

  it('reads the processes of macOS ps output', () => {
    const text = [
      '    1     0   73:17.52 Fri Nov  6 19:54:19 2026    ',
      '  526     1 1-02:03:04.05 Sat Nov  7 03:00:00 2026',
      'not a process',
      '  527   526    bad Sat Nov  7 03:00:00 2026',
      '',
    ].join('\n');
    expect(parsePs(text)).toEqual([
      { pid: 1, ppid: 0, start: 'Fri Nov 6 19:54:19 2026', cpuMs: 4_397_520 },
      { pid: 526, ppid: 1, start: 'Sat Nov 7 03:00:00 2026', cpuMs: 93_784_050 },
    ]);
  });

  it('reads a Linux /proc/<pid>/stat: ppid field 4, utime and stime fields 14 and 15 in clock ticks, starttime field 22', () => {
    // the command name holds spaces and parentheses
    const stat = '1234 (my (odd) proc) S 77 1234 1234 0 -1 4194560 100 0 0 0 250 50 9 9 20 0 3 0 98765 1000 10 18446744073709551615\n';
    expect(parseProcStat(stat, 100)).toEqual({ pid: 1234, ppid: 77, start: '98765', cpuMs: 3000 });
    expect(parseProcStat(stat, 250)).toMatchObject({ cpuMs: 1200 });
    expect(parseProcStat('1234 no command name S 1', 100)).toBeNull();
    expect(parseProcStat('1234 (short) S 1 2 3', 100)).toBeNull();
  });

  it('reads the processes of a Linux proc folder, leaving out one that ended while it was read', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'ogw-proc-'));
    const stat = (pid: number, ppid: number, utime: number): string =>
      `${String(pid)} (godot worker) R ${String(ppid)} 1 1 0 -1 0 0 0 0 0 ${String(utime)} 0 0 0 20 0 1 0 555 0 0\n`;
    for (const [pid, ppid, utime] of [[1, 0, 10], [42, 1, 300]] as const) {
      mkdirSync(join(proc, String(pid)));
      writeFileSync(join(proc, String(pid), 'stat'), stat(pid, ppid, utime));
    }
    // not a process, and a process whose folder has no stat any more
    mkdirSync(join(proc, 'self'));
    writeFileSync(join(proc, 'self', 'stat'), stat(9, 1, 1));
    mkdirSync(join(proc, '77'));
    const read = await procProcesses(proc, 100);
    expect(read?.sort((a, b) => a.pid - b.pid)).toEqual([
      { pid: 1, ppid: 0, start: '555', cpuMs: 100 },
      { pid: 42, ppid: 1, start: '555', cpuMs: 3000 },
    ]);
    expect(await procProcesses(join(proc, 'missing'), 100)).toBeNull();
  });

  it('is a failed reading (null) when the proc folder cannot be read, and throws a stat that cannot be read for another reason', async () => {
    const proc = mkdtempSync(join(tmpdir(), 'ogw-proc-'));
    // a file where the proc folder is: a system error of the reading
    writeFileSync(join(proc, 'file'), '');
    expect(await procProcesses(join(proc, 'file'), 100)).toBeNull();
    // a stat that is a folder is no process that ended
    mkdirSync(join(proc, '5', 'stat'), { recursive: true });
    await expect(procProcesses(proc, 100)).rejects.toMatchObject({ code: 'EISDIR' });
  });
});

describe('CPU time of an instance tree', () => {
  const at = (pid: number, ppid: number, cpuMs: number, start = 'a'): ProcessCpu => ({ pid, ppid, start, cpuMs });
  // supervisor 100: client 101 with worker 102, client 103 that ends, client 104 that starts, 105 whose pid another
  // process takes; 200 is outside the instance
  const before = processReading([at(1, 0, 0), at(100, 1, 0), at(101, 100, 0), at(102, 101, 0), at(103, 100, 0), at(105, 100, 0), at(200, 1, 0)]);
  const after = processReading([at(1, 0, 0), at(100, 1, 10), at(101, 100, 100), at(102, 101, 1000), at(104, 100, 5000), at(105, 100, 7000, 'b'), at(200, 1, 9000)]);

  it('sums the CPU time of the root and its descendants seen in both readings', () => {
    expect(treeCpuMs(before, after, 100)).toBe(1110);
    expect(treeCpuMs(before, after, 101)).toBe(1100);
    expect(treeCpuMs(before, after, 200)).toBe(9000);
  });

  it('is 0 without a reading or a root', () => {
    expect(treeCpuMs(null, after, 100)).toBe(0);
    expect(treeCpuMs(before, null, 100)).toBe(0);
    expect(treeCpuMs(before, after, null)).toBe(0);
    expect(treeCpuMs(before, after, 999)).toBe(0);
  });
});

/** Starts `node -e script` in its own process group and waits for its first output line. */
async function startNode(script: string): Promise<{ child: ChildProcess; line: string }> {
  const child = spawn(process.execPath, ['-e', script], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const line = await new Promise<string>((resolve, reject) => {
    child.stdout.once('data', (chunk: Buffer) => {
      resolve(chunk.toString('utf8').trim());
    });
    child.once('error', reject);
  });
  return { child, line };
}

function stopGroup(child: ChildProcess): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    // already gone
  }
}

describe.skipIf(!['darwin', 'linux'].includes(process.platform))('hostProbe processes of this host', () => {
  it('reads the CPU time that the descendants of a process use, and not that of another process', async () => {
    // a parent that does nothing but has a busy child, and a process that sleeps
    const busy = await startNode(
      "const c = require('child_process').spawn(process.execPath, ['-e', 'for (;;) {}'], { stdio: 'ignore' }); console.log(c.pid); setInterval(() => {}, 1000);",
    );
    const idle = await startNode("console.log('ready'); setInterval(() => {}, 1000);");
    try {
      const probe = hostProbe(fakeContext());
      const first = await probe.processes();
      expect(first).not.toBeNull();
      const before = processReading(first ?? []);
      const [busyRoot, idleRoot] = [busy.child.pid ?? null, idle.child.pid ?? null];
      // the busy loop uses up to one core: on a host busy with other work it takes longer to reach 300 ms, so the
      // readings go on until it does instead of over a fixed time
      let after = before;
      for (const deadline = Date.now() + 20_000; treeCpuMs(before, after, busyRoot) < 300 && Date.now() < deadline; ) {
        await sleep(250);
        after = processReading((await probe.processes()) ?? []);
      }
      expect([...after.values()].find((p) => p.pid === Number(busy.line))?.ppid).toBe(busy.child.pid);
      expect(treeCpuMs(before, after, busyRoot)).toBeGreaterThanOrEqual(300);
      expect(treeCpuMs(before, after, idleRoot)).toBeLessThan(100);
    } finally {
      stopGroup(busy.child);
      stopGroup(idle.child);
    }
  });
});

describe('hostProbe supervisorPid', () => {
  it('reads the supervisor pid of an instance record', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-instances-'));
    writeFileSync(join(dir, 'i1.json'), JSON.stringify({ id: 'i1', supervisorPid: 4321 }));
    const probe = hostProbe({ ...fakeContext(), env: { OGW_INSTANCES_DIR: dir } });
    expect(await probe.supervisorPid('i1')).toBe(4321);
    writeFileSync(join(dir, 'i2.json'), JSON.stringify({ id: 'i2' }));
    expect(await probe.supervisorPid('i2')).toBeNull();
    // an instance without a record: the error is thrown, not read as an instance without a supervisor
    await expect(probe.supervisorPid('none')).rejects.toThrow('instance not found: none');
  });
});
