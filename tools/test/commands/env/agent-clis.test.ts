import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { baseCli, claudeHelpEfforts, cliModelChecks, cliVersionChecks, codexCatalogModels, installSource, versionLower } from '../../../src/commands/env/lib/agent-clis.ts';
import { cliStates } from '../../../src/commands/env/lib/hostcheck.ts';
import { setNet } from '../../../src/commands/env/lib/net.ts';
import { computeNotices } from '../../../src/commands/env/lib/proposals.ts';
import type { CliVersionCheck, EnvCheckResult } from '../../../src/commands/env/lib/results.ts';
import { createContext } from '../../../src/lib/command.ts';
import { makeWorkspace, ogw, type TestWorkspace } from '../../helpers/workspace.ts';
import { fakeBin, fakeNet } from './fakes.ts';

/** `claude --help` as Claude Code 2.1.296 prints it to a pipe: the levels of `--effort` wrap onto the next line. */
const CLAUDE_HELP = [
  'Options:',
  '  --disallowedTools <tools...>          Comma or space-separated list of tool names to deny',
  '  --effort <level>                      Effort level for the current session',
  '                                        (low, medium, high, xhigh, max)',
  '  --exclude-dynamic-system-prompt-sections',
  '      Move per-machine sections (cwd, env info) from the system prompt (default: false)',
].join('\n');

/** The result object of `claude -p --output-format json` with `modelUsage` of `models`. */
function resultObject(models: string[]): string {
  const usage = Object.fromEntries(models.map((model) => [model, { inputTokens: 9, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 }]));
  return JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', num_turns: 1, total_cost_usd: 0.001, modelUsage: usage });
}

/** The catalog of `codex debug models`: two listed models and a hidden one. */
const CODEX_CATALOG = {
  models: [
    { slug: 'gpt-a', display_name: 'A', description: 'Frontier model.', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'high' }, { effort: 'ultra' }] },
    { slug: 'hidden', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
    { slug: 'gpt-b', description: 'Fast model.', visibility: 'list', supported_reasoning_levels: [{ effort: 'medium' }] },
  ],
};

/**
 * A workspace with fake `claude` and `codex` on PATH. The fake claude answers `--help` with `CLAUDE_HELP`, records each
 * prompt run in `claude-runs.jsonl`, fails `--model fable`, names two models for `--model haiku` and one model per
 * other alias; the fake codex prints `catalog.json` for `debug models`.
 */
function setup(): { ws: TestWorkspace; env: NodeJS.ProcessEnv; bin: string } {
  const ws = makeWorkspace();
  const bin = join(ws.root, 'bin');
  writeFileSync(join(ws.root, 'help.txt'), CLAUDE_HELP);
  writeFileSync(join(ws.root, 'catalog.json'), JSON.stringify(CODEX_CATALOG));
  const results = { opus: resultObject(['claude-opus-5-5']), sonnet: resultObject(['claude-sonnet-5-5']), haiku: resultObject(['claude-haiku-5-5', 'claude-opus-5-5']) };
  for (const [alias, text] of Object.entries(results)) writeFileSync(join(ws.root, `${alias}.json`), text);
  // the play and judge sandbox: macOS `sandbox-exec -f <profile>`, Linux `bwrap ... -- <command>`
  const sandbox = 'if [ "$1" = -p ] || [ "$1" = -f ]; then shift 2; else while [ "$1" != -- ]; do shift; done; shift; fi\nexec "$@"';
  fakeBin(bin, {
    'sandbox-exec': sandbox,
    bwrap: sandbox,
    claude: [
      'if [ "$1" = auth ]; then exit 0; fi',
      `if [ "$1" = --help ]; then /bin/cat "${join(ws.root, 'help.txt')}"; exit 0; fi`,
      'if [ "$1" = --version ]; then echo "2.1.296 (Claude Code)"; exit 0; fi',
      `printf '%s\\n' "$*" >> "${join(ws.root, 'claude-runs.jsonl')}"`,
      '/bin/cat > /dev/null',
      'if [ "$3" = fable ]; then echo "model fable is not available" >&2; exit 1; fi',
      `/bin/cat "${ws.root}/$3.json"`,
    ].join('\n'),
    codex: [
      'if [ "$1" = login ]; then echo "Logged in using ChatGPT"; exit 0; fi',
      'if [ "$1" = --version ]; then echo "codex-cli 0.164.0"; exit 0; fi',
      `if [ "$1" = debug ] && [ "$2" = models ]; then /bin/cat "${join(ws.root, 'catalog.json')}"; exit 0; fi`,
      'exit 9',
    ].join('\n'),
  });
  return { ws, env: { ...ws.env, PATH: `${bin}:/usr/bin:/bin`, CLAUDECODE: '', CODEX_THREAD_ID: '' }, bin };
}

function context(ws: TestWorkspace, env: NodeJS.ProcessEnv): ReturnType<typeof createContext> {
  return createContext({ cwd: ws.root, env, stdin: () => Promise.resolve(''), stderr: () => undefined });
}

afterEach(() => {
  setNet(null);
});

describe('env check: base CLI', () => {
  it('is the agent CLI whose variable the environment has, and unknown with the reason for neither or both', () => {
    expect(baseCli({ CLAUDECODE: '1' })).toEqual({ cli: 'claude-code', reason: null });
    expect(baseCli({ CODEX_THREAD_ID: '01a1b10a-4e30-7ec1-b0cc-8edbc88619e9' })).toEqual({ cli: 'codex', reason: null });
    expect(baseCli({ CLAUDECODE: '0', CODEX_THREAD_ID: '' })).toEqual({ cli: null, reason: 'CLAUDECODE is not 1 and CODEX_THREAD_ID is not set' });
    expect(baseCli({ CLAUDECODE: '1', CODEX_THREAD_ID: 't' })).toEqual({ cli: null, reason: 'CLAUDECODE is 1 and CODEX_THREAD_ID is set' });
  });

  it('is in the result and the text of ogw env check', async () => {
    const { ws, env } = setup();
    const run = await ogw(ws, ['env', 'check', '--json'], { env: { ...env, CODEX_THREAD_ID: 't1' } });
    expect((JSON.parse(run.stdout) as EnvCheckResult).baseCli).toEqual({ cli: 'codex', reason: null });
    const text = await ogw(ws, ['env', 'check'], { env });
    expect(text.stdout).toContain('base CLI: unknown (CLAUDECODE is not 1 and CODEX_THREAD_ID is not set)\n');
  });
});

describe('env check: model list', () => {
  it('reads the efforts of claude --help from the description of --effort, also when it wraps', () => {
    expect(claudeHelpEfforts(CLAUDE_HELP)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(claudeHelpEfforts('  --effort <level>  Effort level (low, high)\n  --model <m>  (x, y)')).toEqual(['low', 'high']);
    // the parentheses of the next option are not those of --effort
    expect(claudeHelpEfforts('  --effort <level>  Effort level\n  --model <m>  Model (x, y)')).toBeNull();
    expect(claudeHelpEfforts('Options:\n  --model <m>')).toBeNull();
  });

  it('lists the models of the Codex catalog whose visibility is list, and is unknown when the catalog cannot be read', () => {
    expect(codexCatalogModels(JSON.stringify(CODEX_CATALOG))).toEqual([
      { id: 'gpt-a', alias: null, efforts: ['low', 'high', 'ultra'], description: 'Frontier model.' },
      { id: 'gpt-b', alias: null, efforts: ['medium'], description: 'Fast model.' },
    ]);
    expect(codexCatalogModels('not json')).toBe('codex debug models printed no JSON');
    expect(codexCatalogModels('{"data": []}')).toBe('the output of codex debug models has no models array');
    expect(codexCatalogModels('{"models": [{"visibility": "list"}]}')).toBe('a listed model of codex debug models has no slug');
  });

  it('runs each Claude Code alias once and lists the one model of its result object, each unreadable alias unknown with its reason', async () => {
    const { ws, env } = setup();
    const lists = await cliModelChecks(context(ws, env), cliStates(env));
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    expect(lists).toEqual([
      {
        cli: 'claude-code',
        models: [
          { id: 'claude-opus-5-5', alias: 'opus', efforts, description: null },
          { id: 'claude-sonnet-5-5', alias: 'sonnet', efforts, description: null },
        ],
        unknown: ['fable: the prompt run ended with code 1: model fable is not available', 'haiku: the result object names the models claude-haiku-5-5, claude-opus-5-5'],
      },
      {
        cli: 'codex',
        models: [
          { id: 'gpt-a', alias: null, efforts: ['low', 'high', 'ultra'], description: 'Frontier model.' },
          { id: 'gpt-b', alias: null, efforts: ['medium'], description: 'Fast model.' },
        ],
        unknown: [],
      },
    ]);
    // one prompt run per alias, at the lowest effort, without a session file, with the JSON result object
    const runs = readFileSync(join(ws.root, 'claude-runs.jsonl'), 'utf8').trim().split('\n').sort();
    expect(runs).toEqual(
      ['fable', 'haiku', 'opus', 'sonnet'].map(
        (alias) => `-p --model ${alias} --effort low --permission-mode bypassPermissions --output-format json --no-session-persistence`,
      ),
    );
  });

  it('lists no models of a CLI that is not logged in, and is unknown when codex debug models fails', async () => {
    const { ws, env, bin } = setup();
    fakeBin(bin, { claude: 'if [ "$1" = auth ]; then exit 1; fi\nexit 9', codex: 'if [ "$1" = login ]; then exit 0; fi\necho "unknown command debug" >&2\nexit 2' });
    expect(await cliModelChecks(context(ws, env), cliStates(env))).toEqual([
      { cli: 'codex', models: [], unknown: ['codex debug models ended with code 2: unknown command debug'] },
    ]);
  });

  it('writes the model lists in the text of ogw env check', async () => {
    const { ws, env } = setup();
    const text = (await ogw(ws, ['env', 'check'], { env })).stdout;
    expect(text).toContain(
      'models of claude-code: claude-opus-5-5 (alias opus; efforts low medium high xhigh max), claude-sonnet-5-5 (alias sonnet; efforts low medium high xhigh max); unknown: fable: the prompt run ended with code 1: model fable is not available; haiku: the result object names the models claude-haiku-5-5, claude-opus-5-5\n',
    );
    expect(text).toContain('models of codex: gpt-a (efforts low high ultra; Frontier model.), gpt-b (efforts medium; Fast model.)\n');
  });
});

describe('env check: version', () => {
  it('compares versions by their numbers', () => {
    expect(versionLower('0.164.0', '0.167.0')).toBe(true);
    expect(versionLower('2.1.296', '2.1.30')).toBe(false);
    expect(versionLower('2.1.319', '2.1.319')).toBe(false);
    expect(versionLower('1.9.9', '2.0.0')).toBe(true);
  });

  it('finds the install source from the real path of the program', () => {
    const home = '/Users/u';
    const of = (path: string): { source: string; update: string } | null => {
      const source = installSource(path, home);
      return source === null ? null : { source: source.source, update: source.update };
    };
    expect(of('/opt/homebrew/Caskroom/claude-code@latest/2.1.296/claude')).toEqual({ source: 'Homebrew cask claude-code@latest', update: 'brew upgrade --cask claude-code@latest' });
    expect(of('/opt/homebrew/Cellar/codex/0.164.0/bin/codex')).toEqual({ source: 'Homebrew formula codex', update: 'brew upgrade codex' });
    expect(of('/opt/homebrew/lib/node_modules/@openai/codex/bin/codex.js')).toEqual({ source: 'npm package @openai/codex', update: 'npm install --global @openai/codex@latest' });
    expect(of('/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js')).toEqual({
      source: 'npm package @anthropic-ai/claude-code',
      update: 'npm install --global @anthropic-ai/claude-code@latest',
    });
    expect(of('/Users/u/.local/share/claude/versions/2.1.296')).toEqual({ source: 'Claude Code installer', update: 'claude update' });
    expect(of('/Users/u/bin/claude')).toBeNull();
    // a folder named like a source, without the program inside it
    expect(of('/opt/homebrew/Caskroom/claude')).toBeNull();
  });

  it('compares the installed version with the latest one of its install source, and is unknown with the reason', async () => {
    const { ws, env, bin } = setup();
    // claude from a Homebrew cask, codex from npm: the program on PATH links into each
    const cask = join(ws.root, 'opt', 'homebrew', 'Caskroom', 'claude-code@latest', '2.1.296');
    const npm = join(ws.root, 'opt', 'homebrew', 'lib', 'node_modules', '@openai', 'codex', 'bin');
    mkdirSync(cask, { recursive: true });
    mkdirSync(npm, { recursive: true });
    fakeBin(cask, { claude: 'echo "2.1.296 (Claude Code)"' });
    fakeBin(npm, { 'codex.js': 'echo "codex-cli 0.164.0"' });
    const links = join(ws.root, 'links');
    mkdirSync(links);
    symlinkSync(join(cask, 'claude'), join(links, 'claude'));
    symlinkSync(join(npm, 'codex.js'), join(links, 'codex'));
    const linked = { ...env, PATH: `${links}:/usr/bin:/bin` };
    setNet(
      fakeNet({
        'https://formulae.brew.sh/api/cask/claude-code@latest.json': { token: 'claude-code@latest', version: '2.1.296' },
        'https://registry.npmjs.org/@openai/codex/latest': { name: '@openai/codex', version: '0.167.0' },
      }),
    );
    expect(await cliVersionChecks(linked)).toEqual([
      { cli: 'claude-code', installed: '2.1.296', source: 'Homebrew cask claude-code@latest', latest: '2.1.296', behind: false, update: 'brew upgrade --cask claude-code@latest', reason: null },
      { cli: 'codex', installed: '0.164.0', source: 'npm package @openai/codex', latest: '0.167.0', behind: true, update: 'npm install --global @openai/codex@latest', reason: null },
    ]);
    // the source does not answer; a program outside every source
    setNet(fakeNet({}));
    const unknown = await cliVersionChecks({ ...env, PATH: `${links}:${bin}:/usr/bin:/bin` });
    expect(unknown[0]).toMatchObject({ cli: 'claude-code', installed: '2.1.296', latest: null, behind: null });
    expect(unknown[0]?.reason).toContain('cannot read the latest version of Homebrew cask claude-code@latest: GET https://formulae.brew.sh/api/cask/claude-code@latest.json answered 404');
    const outside = await cliVersionChecks(env);
    expect(outside[0]).toMatchObject({ cli: 'claude-code', installed: '2.1.296', source: null, behind: null });
    expect(outside[0]?.reason).toBe(`${join(bin, 'claude')} is not under a Homebrew cask, a Homebrew formula, an npm package or the Claude Code installer`);
  });

  it('gives the notice agent-cli-version for an agent CLI behind its latest version', async () => {
    const { ws, env } = setup();
    const version = (cli: 'claude-code' | 'codex', installed: string, latest: string | null, behind: boolean | null): CliVersionCheck => ({
      cli,
      installed,
      source: 'npm package @openai/codex',
      latest,
      behind,
      update: 'npm install --global @openai/codex@latest',
      reason: behind === null ? 'x' : null,
    });
    const check = {
      checkedAt: 1,
      programs: { docker: { found: true, version: 'd' }, dockerBuildx: { found: true, version: 'b' } },
      gh: { loggedIn: true, scopes: ['write:packages'] },
      testDevices: [],
      agentClis: [],
      providerClis: [],
      cliVersions: [version('codex', '0.164.0', '0.167.0', true), version('claude-code', '2.1.319', '2.1.319', false), version('claude-code', '2.1.1', null, null)],
    } as unknown as EnvCheckResult;
    const ctx = context(ws, env);
    const notices = await computeNotices(ctx, { settings: await ctx.settings(), check, install: null, measure: null, instances: null });
    expect(notices.filter((n) => n.id === 'agent-cli-version')).toEqual([
      {
        id: 'agent-cli-version',
        detail: 'codex 0.164.0 is behind 0.167.0, the latest version of npm package @openai/codex, so its model list may lack the newest models. Update it with npm install --global @openai/codex@latest',
      },
    ]);
  });
});
