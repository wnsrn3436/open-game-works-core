import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setAgentProbeMs } from '../../../src/commands/env/lib/hostcheck.ts';
import { bearerValueProblem } from '../../../src/commands/secret/lib/login-token.ts';
import { ogw, makeWorkspace, testSettings, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin } from '../env/fakes.ts';

/** The play and judge sandbox: macOS `sandbox-exec -f <profile>` or `-p <profile>`, Linux `bwrap ... -- <command>`. */
const SANDBOX = 'if [ "$1" = -p ] || [ "$1" = -f ]; then shift 2; else while [ "$1" != -- ]; do shift; done; shift; fi\nSANDBOXED=yes exec "$@"';

/**
 * Claude Code in print mode with stream-json output: `good` passes, `offline` fails without an authentication
 * failure, `hang` does not end, `blank-result` fails with a whitespace result and stderr, `rejected-exit0` fails to authenticate and exits 0, any other token fails to
 * authenticate. Each run logs its folder, sandbox, TMPDIR and arguments.
 */
const CLAUDE = [
  'if [ "$1" != -p ]; then exit 9; fi',
  'prompt=$(/bin/cat)',
  'echo "$PWD|$SANDBOXED|$TMPDIR|$*|$prompt" >> "$FAKE_CLAUDE_LOG"',
  'case "$CLAUDE_CODE_OAUTH_TOKEN" in',
  '  good) echo \'{"type":"system","subtype":"init"}\'; echo \'{"type":"result","subtype":"success","is_error":false,"result":"ok"}\'; exit 0;;',
  '  offline) echo "connect ECONNREFUSED" >&2; exit 1;;',
  '  hang) exec /bin/sleep 30;;',
  '  blank-result) echo \'{"type":"result","is_error":true,"result":" "}\'; echo "rate limited" >&2; exit 1;;',
  '  rejected-exit0) echo \'{"type":"assistant","error":"authentication_failed","message":{"content":[]}}\'; echo \'{"type":"result","is_error":true,"result":"Invalid API key"}\'; exit 0;;',
  'esac',
  'echo \'{"type":"system","subtype":"api_retry","error_status":401,"error":"authentication_failed"}\'',
  'echo \'{"type":"assistant","error":"authentication_failed","message":{"content":[{"type":"text","text":"Failed to authenticate."}]}}\'',
  'echo \'{"type":"result","subtype":"success","is_error":true,"result":"Failed to authenticate. API Error: 401 Invalid bearer token"}\'',
  'exit 1',
].join('\n');

const SERVICE = 'ogw/harness/claude-code-oauth-token';
const ONE_LINE = "Store it on one line, for example on macOS: pbpaste | tr -d '[:space:]' | tools/bin/ogw secret set --harness claude-code-oauth-token";

let ws: TestWorkspace;
let env: NodeJS.ProcessEnv;
let log: string;

function store(): Record<string, string> {
  const file = join(ws.root, 'secrets.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, string>) : {};
}

function setToken(stdin: string): ReturnType<typeof ogw> {
  return ogw(ws, ['secret', 'set', '--harness', 'claude-code-oauth-token'], { stdin, env });
}

beforeEach(() => {
  ws = makeWorkspace();
  const bin = fakeBin(join(ws.root, 'bin'), { claude: CLAUDE, 'sandbox-exec': SANDBOX, bwrap: SANDBOX });
  mkdirSync(join(ws.root, 'tmp'));
  log = join(ws.root, 'claude.log');
  env = { ...ws.env, PATH: `${bin}:${process.env.PATH ?? ''}`, TMPDIR: join(ws.root, 'tmp'), FAKE_CLAUDE_LOG: log };
});

afterEach(() => {
  setAgentProbeMs(null);
});

describe('ogw secret set --harness claude-code-oauth-token', () => {
  it('refuses a value that cannot be an HTTP Bearer value, runs nothing and stores nothing', async () => {
    const cases: [string, string][] = [
      ['abc\ndef\n', 'character 4 is a whitespace'],
      ['abc def', 'character 4 is a whitespace'],
      ['abc\tdef', 'character 4 is a whitespace'],
      ['abc\r\ndef', 'character 4 is a whitespace'],
      ['abc\u0001', 'character 4 is a control character'],
      ['abc\u007f', 'character 4 is a control character'],
      ['abéc', 'character 3 is a non-ASCII character'],
      ['a\u{1f600}b c', 'character 2 is a non-ASCII character'],
      [' good', 'character 1 is a whitespace'],
    ];
    for (const [stdin, problem] of cases) {
      expect(await setToken(stdin)).toEqual({
        code: 1,
        stdout: '',
        stderr: `claude-code-oauth-token not stored: it is not an HTTP Authorization Bearer value (one line of printable ASCII without spaces): ${problem}. ${ONE_LINE}\n`,
      });
    }
    expect(store()).toEqual({});
    expect(existsSync(log)).toBe(false);
  });

  it('stores a token that Claude Code accepts in the play agent sandbox, with one trailing newline removed', async () => {
    expect(await setToken('good\n')).toEqual({ code: 0, stdout: 'stored claude-code-oauth-token\n', stderr: '' });
    expect(store()).toEqual({ [SERVICE]: 'good' });
    const [folder, sandboxed, tmp, args, prompt] = readFileSync(log, 'utf8').trim().split('|');
    // the folder, sandbox, command and prompt of the `ogw env check` run of play, with stream-json output
    expect(folder?.startsWith(join(ws.root, 'tmp', 'ogw-play-'))).toBe(true);
    expect(existsSync(folder as string)).toBe(false);
    expect(sandboxed).toBe('yes');
    expect(tmp).toBe(join(folder as string, 'tmp'));
    expect(args).toBe('-p --model claude-sonnet-5-5 --effort medium --permission-mode bypassPermissions --no-session-persistence --output-format stream-json --verbose');
    expect(prompt).toBe('Reply with the single word ok.');
  });

  it('refuses a token Claude Code fails to authenticate with, showing the CLI error', async () => {
    writeFileSync(join(ws.root, 'secrets.json'), JSON.stringify({ [SERVICE]: 'good' }));
    expect(await setToken('expired')).toEqual({
      code: 1,
      stdout: '',
      stderr:
        'claude-code-oauth-token not stored: Claude Code in the play agent sandbox failed to authenticate with it: Failed to authenticate. API Error: 401 Invalid bearer token\n' +
        "make a long-lived token with `claude setup-token` and store it on one line, for example on macOS: pbpaste | tr -d '[:space:]' | tools/bin/ogw secret set --harness claude-code-oauth-token\n",
    });
    expect(store()).toEqual({ [SERVICE]: 'good' });
  });

  it('refuses a token Claude Code fails to authenticate with even when it exits 0', async () => {
    const out = await setToken('rejected-exit0');
    expect(out.code).toBe(1);
    expect(out.stderr).toContain('claude-code-oauth-token not stored: Claude Code in the play agent sandbox failed to authenticate with it: Invalid API key\n');
    expect(store()).toEqual({});
  });

  it('refuses a token whose run does not end within the time limit', async () => {
    setAgentProbeMs(500);
    expect(await setToken('hang')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'claude-code-oauth-token not stored: the Claude Code run with it in the play agent sandbox failed: timed out after 500 ms\n',
    });
    expect(store()).toEqual({});
  });

  it('refuses a token whose run fails otherwise, showing stderr', async () => {
    expect(await setToken('offline')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'claude-code-oauth-token not stored: the Claude Code run with it in the play agent sandbox failed: connect ECONNREFUSED\n',
    });
    expect(store()).toEqual({});
  });

  it('shows stderr when the result message has no text but whitespace', async () => {
    expect((await setToken('blank-result')).stderr).toBe('claude-code-oauth-token not stored: the Claude Code run with it in the play agent sandbox failed: rate limited\n');
    expect(store()).toEqual({});
  });

  it('checks with the judge settings when only judge uses Claude Code, and stores nothing when neither does', async () => {
    const agents = testSettings().agents as Record<string, object>;
    const codex = { cli: 'codex', model: 'm', effort: 'high' };
    ws = makeWorkspace({ agents: { ...agents, play: codex } });
    env = { ...env, ...ws.env, PATH: env.PATH, TMPDIR: env.TMPDIR };
    expect((await setToken('good')).code).toBe(0);
    const [folder, sandboxed, , args] = readFileSync(log, 'utf8').trim().split('|');
    expect(folder?.startsWith(join(env.TMPDIR as string, 'ogw-judge-'))).toBe(true);
    expect(sandboxed).toBe('yes');
    expect(args?.startsWith('-p --model claude-opus-5-5 --effort high ')).toBe(true);
    ws = makeWorkspace({ agents: { ...agents, play: codex, judge: codex } });
    env = { ...env, ...ws.env, PATH: env.PATH, TMPDIR: env.TMPDIR };
    expect(await setToken('good')).toEqual({
      code: 1,
      stdout: '',
      stderr: 'claude-code-oauth-token not stored: harness settings agents play and judge do not use Claude Code, so no agent uses it\n',
    });
    expect(store()).toEqual({});
  });
});

describe('bearerValueProblem', () => {
  it('accepts printable ASCII without space and names no character of the value', () => {
    expect(bearerValueProblem('!~azAZ09-._~+/=')).toBeNull();
    expect(bearerValueProblem('x'.repeat(500))).toBeNull();
    expect(bearerValueProblem('secret value')).toBe('character 7 is a non-ASCII character');
  });
});
