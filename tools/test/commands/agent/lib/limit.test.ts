import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { agentHitLimit, hasLimitMessage } from '../../../../src/commands/agent/lib/limit.ts';

describe('hasLimitMessage', () => {
  it('finds the usage limit and rate limit lines that Claude Code prints as its result', () => {
    for (const line of [
      "You've hit your session limit · resets 3pm (Asia/Seoul)",
      "You've hit your weekly limit · resets Nov 9, 1am",
      "You've hit your limit · resets 5pm",
      "You've reached your Fable limit.",
      "You're out of usage credits · resets 3pm",
      'Your org is out of usage · contact your admin',
      'API Error: Request rejected (429) · this may be a temporary capacity issue.',
      'API Error: Server is temporarily limiting requests (not your usage limit) · Rate limited',
    ]) {
      expect(hasLimitMessage('claude-code', `I played A.\n${line}\n`)).toBe(true);
    }
  });

  it('finds the usage limit and rate limit errors that codex exec prints on stderr', () => {
    for (const line of [
      'ERROR: You’ve hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again at Nov 6th, 2026 9:00 PM.',
      'ERROR: You’ve hit your usage limit for GPT-6-Astra. Switch to another model now, or try again later.',
      'ERROR: Your workspace is out of credits. Add credits to continue.',
      'ERROR: You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
      'ERROR: Quota exceeded. Check your plan and billing details.',
      'ERROR: exceeded retry limit, last status: 429 Too Many Requests, request id: abc',
      'ERROR: rate limit exceeded: slow down',
    ]) {
      expect(hasLimitMessage('codex', `OpenAI Codex v0.164.0\n--------\n${line}\n`)).toBe(true);
    }
  });

  it('takes only the messages of that agent CLI at the start of a line, and no other failure', () => {
    expect(hasLimitMessage('codex', "You've hit your session limit · resets 3pm\n")).toBe(false);
    expect(hasLimitMessage('claude-code', 'ERROR: Quota exceeded. Check your plan and billing details.\n')).toBe(false);
    // the ASCII apostrophe is not what codex prints
    expect(hasLimitMessage('codex', "ERROR: You've hit your usage limit.\n")).toBe(false);
    expect(hasLimitMessage('claude-code', "the judge wrote: You've hit your limit\n")).toBe(false);
    for (const other of ['API Error: 500 Internal server error', 'Execution error', 'Error: Reached max turns (40)', 'Opus is experiencing high load, please use /model to switch to Sonnet']) {
      expect(hasLimitMessage('claude-code', `${other}\n`)).toBe(false);
    }
    for (const other of ['ERROR: stream disconnected before completion: idle timeout', 'ERROR: Selected model is at capacity. Please try a different model.', 'ERROR: exceeded retry limit, last status: 500 Internal Server Error']) {
      expect(hasLimitMessage('codex', `${other}\n`)).toBe(false);
    }
    expect(hasLimitMessage('claude-code', '')).toBe(false);
  });
});

describe('agentHitLimit', () => {
  it('reads the agent CLI output of the job, and finds no limit without one', async () => {
    const jobs = mkdtempSync(join(tmpdir(), 'ogw-limit-'));
    const env = { ...process.env, OGW_JOBS_DIR: jobs };
    mkdirSync(join(jobs, 'agent-logs'));
    writeFileSync(join(jobs, 'agent-logs', 'j1.cli.log'), 'reading input\r\nERROR: You’ve hit your usage limit. Try again later.\r\n');
    writeFileSync(join(jobs, 'agent-logs', 'j2.cli.log'), 'ERROR: stream disconnected before completion\n');
    expect(await agentHitLimit('j1', 'codex', env)).toBe(true);
    expect(await agentHitLimit('j2', 'codex', env)).toBe(false);
    expect(await agentHitLimit('j3', 'codex', env)).toBe(false);
  });
});
