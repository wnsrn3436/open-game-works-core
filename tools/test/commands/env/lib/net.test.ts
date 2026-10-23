import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitOfRef, net, remoteCommit, requestJson, setDownloadIdleMs, setDownloadRetryMs, setNet } from '../../../../src/commands/env/lib/net.ts';
import { archiveKind, downloadChecked, extractArchive, findFile, listFiles, sha256File, sha256Text, urlFileName } from '../../../../src/commands/env/lib/files.ts';
import { dataDir, envResultPath, hostPlatform, hostPlatformOf, safeSegment, whichIn } from '../../../../src/commands/env/lib/host.ts';
import { commitAll, gitInit, makeWorkspace, sh, useGitOnlyHarness } from '../../../helpers/workspace.ts';
import { fakeBin } from '../fakes.ts';
import { createContext } from '../../../../src/lib/command.ts';
import { privateTempDir } from '../../../../src/lib/secret-files.ts';
import { commonDir } from '../../../../src/lib/git.ts';
import { byteCompare } from '../../../../src/lib/order.ts';

let server: Server;
const flakyRanges: (string | null)[] = [];
const crossFlakyRanges: (string | null)[] = [];
const crossFlakyTokens: (string | null)[] = [];

/** The first answer breaks after half the body; later answers honor Range. */
function answerFlaky(req: IncomingMessage, res: ServerResponse, ranges: (string | null)[]): void {
  const body = 'abcdefghij'.repeat(1000);
  ranges.push(req.headers.range ?? null);
  if (ranges.length === 1) {
    res.writeHead(200, { 'Content-Length': String(body.length) });
    res.write(body.slice(0, 5000));
    setTimeout(() => res.socket?.destroy(), 20);
    return;
  }
  const start = Number(/^bytes=(\d+)-$/.exec(req.headers.range ?? '')?.[1] ?? 0);
  res.writeHead(206, { 'Content-Range': `bytes ${String(start)}-${String(body.length - 1)}/${String(body.length)}` });
  res.end(body.slice(start));
}
let base = '';
const STALL_REQUEST_IDLE_MS = 50;
const STALL_BODY_IDLE_MS = 300;
/** Whether the `/stall-after-request` test runs: a connection that closes after it does not change the idle time. */
let stallRunning = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Thing': 'yes' });
      res.end('{"a":1}');
    } else if (req.url === '/text') {
      res.writeHead(200);
      res.end('not json');
    } else if (req.url === '/echo') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ method: req.method, token: req.headers['x-token'] ?? null }));
    } else if (req.url === '/file.bin') {
      res.writeHead(200);
      res.end('payload');
    } else if (req.url === '/same-origin-redirect') {
      res.writeHead(302, { Location: '/echo' });
      res.end();
    } else if (req.url === '/cross-origin-redirect') {
      res.writeHead(302, { Location: `${base.replace('127.0.0.1', 'localhost')}/echo` });
      res.end();
    } else if (req.url === '/loop') {
      res.writeHead(302, { Location: '/loop' });
      res.end();
    } else if (req.url === '/flaky') {
      answerFlaky(req, res, flakyRanges);
    } else if (req.url === '/flaky-cross') {
      // a CDN on another origin serves the bytes, as Hugging Face LFS files and GitHub release assets are
      res.writeHead(302, { Location: `${base.replace('127.0.0.1', 'localhost')}/flaky-cdn` });
      res.end();
    } else if (req.url === '/flaky-cdn') {
      crossFlakyTokens.push((req.headers['x-token'] as string | undefined) ?? null);
      answerFlaky(req, res, crossFlakyRanges);
    } else if (req.url === '/stall') {
      res.writeHead(200);
      res.write('part');
    } else if (req.url === '/stall-after-request') {
      // the request of each attempt armed its timer with the short idle time; its body gets the long one
      setDownloadIdleMs(STALL_BODY_IDLE_MS);
      req.on('close', () => {
        if (stallRunning) setDownloadIdleMs(STALL_REQUEST_IDLE_MS);
      });
      res.writeHead(200);
      res.write('part');
    } else {
      res.writeHead(404);
      res.end('missing');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  base = `http://127.0.0.1:${String(typeof address === 'object' && address ? address.port : 0)}`;
});

afterAll(() => {
  server.close();
});

describe('real net', () => {
  // the real git runs in the temp folder of ogw of a test harness repo
  useGitOnlyHarness();

  it('requests, downloads and reads JSON', async () => {
    setNet(null);
    const response = await net().request(`${base}/json`);
    expect(response.status).toBe(200);
    expect(response.headers['x-thing']).toBe('yes');
    expect(response.body.toString()).toBe('{"a":1}');
    expect(await requestJson(`${base}/json`)).toEqual({ a: 1 });
    await expect(requestJson(`${base}/text`)).rejects.toThrow('did not answer JSON');
    await expect(requestJson(`${base}/nope`)).rejects.toThrow('answered 404');
    const dir = mkdtempSync(join(tmpdir(), 'ogw-net-'));
    await net().download(`${base}/file.bin`, join(dir, 'sub', 'f.bin'));
    expect(readFileSync(join(dir, 'sub', 'f.bin'), 'utf8')).toBe('payload');
    await expect(net().download(`${base}/nope`, join(dir, 'x'))).rejects.toThrow('download failed (404)');
    const checked = await downloadChecked(`${base}/file.bin`, sha256Text('payload'), join(dir, 'c'));
    expect(checked.mismatch).toBeNull();
    const bad = await downloadChecked(`${base}/file.bin`, 'f'.repeat(64), join(dir, 'd'));
    expect(bad.mismatch).toEqual({ what: `${base}/file.bin`, path: join(dir, 'd', 'file.bin'), expected: 'f'.repeat(64), actual: sha256Text('payload') });
  });

  it('sends the method and headers it is given', async () => {
    setNet(null);
    expect(JSON.parse((await net().request(`${base}/echo`)).body.toString())).toEqual({ method: 'GET', token: null });
    expect(JSON.parse((await net().request(`${base}/echo`, { headers: { 'X-Token': 't1' } })).body.toString())).toEqual({ method: 'GET', token: 't1' });
    const head = await net().request(`${base}/echo`, { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(head.body.length).toBe(0);
    expect(await requestJson(`${base}/echo`, { 'X-Token': 't2' })).toEqual({ method: 'GET', token: 't2' });
    const dir = mkdtempSync(join(tmpdir(), 'ogw-net-'));
    await net().download(`${base}/echo`, join(dir, 'e.json'), { 'X-Token': 't3' });
    expect(JSON.parse(readFileSync(join(dir, 'e.json'), 'utf8'))).toEqual({ method: 'GET', token: 't3' });
  });

  it('follows redirects, sends headers only to the origin it was given, and fails a stalled body', async () => {
    setNet(null);
    const dir = mkdtempSync(join(tmpdir(), 'ogw-net-'));
    await net().download(`${base}/same-origin-redirect`, join(dir, 'same.json'), { 'X-Token': 't4' });
    expect(JSON.parse(readFileSync(join(dir, 'same.json'), 'utf8'))).toEqual({ method: 'GET', token: 't4' });
    await net().download(`${base}/cross-origin-redirect`, join(dir, 'cross.json'), { 'X-Token': 't5' });
    expect(JSON.parse(readFileSync(join(dir, 'cross.json'), 'utf8'))).toEqual({ method: 'GET', token: null });
    await expect(net().download(`${base}/loop`, join(dir, 'loop'))).rejects.toThrow('more than 10 redirects');
    setDownloadIdleMs(200);
    setDownloadRetryMs(1);
    try {
      await expect(net().download(`${base}/stall`, join(dir, 'stall'))).rejects.toThrow('no data for 200 ms');
    } finally {
      setDownloadIdleMs(null);
      setDownloadRetryMs(null);
    }
  });

  it('fails a stalled body by the body idle timer, not by the timer of the request that got the response', async () => {
    setNet(null);
    const dir = mkdtempSync(join(tmpdir(), 'ogw-net-'));
    stallRunning = true;
    setDownloadIdleMs(STALL_REQUEST_IDLE_MS);
    // longer than the server takes to see the closed connection and set the short idle time again
    setDownloadRetryMs(50);
    try {
      await expect(net().download(`${base}/stall-after-request`, join(dir, 'stall'))).rejects.toThrow(`no data for ${String(STALL_BODY_IDLE_MS)} ms`);
    } finally {
      stallRunning = false;
      setDownloadIdleMs(null);
      setDownloadRetryMs(null);
    }
  }, 10_000);

  it('resumes a broken download from the bytes it already wrote', async () => {
    setNet(null);
    setDownloadRetryMs(1);
    try {
      const dir = mkdtempSync(join(tmpdir(), 'ogw-net-'));
      await net().download(`${base}/flaky`, join(dir, 'flaky.bin'));
      expect(readFileSync(join(dir, 'flaky.bin'), 'utf8')).toBe('abcdefghij'.repeat(1000));
      expect(flakyRanges[0]).toBeNull();
      expect(flakyRanges[1]).toMatch(/^bytes=\d+-$/);
      expect(flakyRanges).toHaveLength(2);
    } finally {
      setDownloadRetryMs(null);
    }
  });

  it('resumes through a redirect to another origin: Range goes there, the token does not', async () => {
    setNet(null);
    setDownloadRetryMs(1);
    try {
      const dir = mkdtempSync(join(tmpdir(), 'ogw-net-'));
      await net().download(`${base}/flaky-cross`, join(dir, 'cross.bin'), { 'X-Token': 't6' });
      expect(readFileSync(join(dir, 'cross.bin'), 'utf8')).toBe('abcdefghij'.repeat(1000));
      expect(crossFlakyRanges[0]).toBeNull();
      expect(crossFlakyRanges[1]).toMatch(/^bytes=[1-9]\d*-$/);
      expect(crossFlakyRanges).toHaveLength(2);
      expect(crossFlakyTokens).toEqual([null, null]);
    } finally {
      setDownloadRetryMs(null);
    }
  });

  it('names the git failure without a trailing newline and removes its temp folder', async () => {
    setNet(null);
    const repo = mkdtempSync(join(tmpdir(), 'ogw-remote-'));
    const missing = join(repo, 'missing');
    const lsError = (await net().lsRemote(missing, ['HEAD']).catch((error: unknown) => error)) as Error;
    expect(lsError.message.startsWith(`git ls-remote ${missing} HEAD failed: `)).toBe(true);
    expect(lsError.message.length).toBeGreaterThan(`git ls-remote ${missing} HEAD failed: `.length);
    expect(lsError.message).toBe(lsError.message.trim());
    const commitId = 'a'.repeat(40);
    const fetchError = (await net().gitFile(missing, commitId, 'x').catch((error: unknown) => error)) as Error;
    expect(fetchError.message.startsWith(`git fetch --quiet --depth 1 origin ${commitId} failed: `)).toBe(true);
    expect(fetchError.message.length).toBeGreaterThan(`git fetch --quiet --depth 1 origin ${commitId} failed: `.length);
    expect(fetchError.message).toBe(fetchError.message.trim());
    gitInit(repo);
    writeFileSync(join(repo, 'f.txt'), 'f');
    const commit = commitAll(repo);
    expect(await net().gitFile(repo, commit, 'f.txt')).toBe('f');
    await expect(net().gitFile(missing, commitId, 'x')).rejects.toThrow('failed');
    expect(await remoteCommit(repo, 'HEAD')).toBe(commit);
    // git ran in folders of the temp folder of ogw, not in the OS temp folder, and they are gone
    expect(readdirSync(await privateTempDir())).toEqual([]);
  });

  it('resolves a ref to the commit of exactly that branch or tag, an annotated tag through its peeled line', async () => {
    setNet(null);
    const repo = mkdtempSync(join(tmpdir(), 'ogw-remote-'));
    gitInit(repo);
    const first = commitAll(repo, 'first');
    sh(repo, 'git', ['tag', '-a', 'v1.0', '-m', 'release']);
    sh(repo, 'git', ['branch', 'feature/main']);
    sh(repo, 'git', ['tag', 'both']);
    sh(repo, 'git', ['branch', 'both']);
    const second = commitAll(repo, 'second');
    sh(repo, 'git', ['tag', 'light']);
    // an annotated tag: the commit, not the tag object
    expect(await remoteCommit(repo, 'v1.0')).toBe(first);
    expect(await remoteCommit(repo, 'refs/tags/v1.0')).toBe(first);
    expect(await remoteCommit(repo, 'light')).toBe(second);
    // `main` is not `feature/main`, which git lists first
    expect(await remoteCommit(repo, 'main')).toBe(second);
    expect(await remoteCommit(repo, 'feature/main')).toBe(first);
    expect(await remoteCommit(repo, 'HEAD')).toBe(second);
    expect(await remoteCommit(repo, 'nothing')).toBeNull();
    await expect(remoteCommit(repo, 'both')).rejects.toThrow('both names both the branch refs/heads/both and the tag refs/tags/both');
    expect(commitOfRef([{ id: 'a', ref: 'refs/heads/x/HEAD' }, { id: 'b', ref: 'HEAD' }], 'HEAD')).toBe('b');
  });

  it('reads git remotes', async () => {
    setNet(null);
    const repo = mkdtempSync(join(tmpdir(), 'ogw-remote-'));
    gitInit(repo);
    writeFileSync(join(repo, 'pyproject.toml'), '[project]\n');
    const commit = commitAll(repo);
    expect(await remoteCommit(repo, 'HEAD')).toBe(commit);
    expect(await remoteCommit(repo, 'refs/heads/none')).toBeNull();
    await expect(remoteCommit(join(repo, 'missing'), 'HEAD')).rejects.toThrow('git ls-remote');
    expect(await net().gitFile(repo, commit, 'pyproject.toml')).toBe('[project]\n');
    expect(await net().gitFile(repo, commit, 'nothing.toml')).toBeNull();
    await expect(net().gitFile(join(repo, 'missing'), commit, 'x')).rejects.toThrow('failed');
  });

  it('gives git a URL that starts with - as a repository, not an option', async () => {
    setNet(null);
    const repo = mkdtempSync(join(tmpdir(), 'ogw-remote-'));
    gitInit(repo);
    const commit = commitAll(repo);
    const marker = join(repo, 'pwned');
    const url = `--upload-pack=touch ${marker}`;
    await expect(net().lsRemote(url, ['HEAD'])).rejects.toThrow(`git ls-remote ${url} HEAD failed`);
    await expect(net().gitFile(url, commit, 'x')).rejects.toThrow('failed');
    expect(existsSync(marker)).toBe(false);
  });
});

describe('files', () => {
  it('hashes, names and lists files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-files-'));
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeFileSync(join(dir, 'b', 'x.txt'), 'x');
    writeFileSync(join(dir, 'a.txt'), 'abc');
    expect(await sha256File(join(dir, 'a.txt'))).toBe(sha256Text('abc'));
    expect(await listFiles(dir)).toEqual(['a.txt', 'b/x.txt']);
    expect(await findFile(dir, (name) => name === 'x.txt')).toBe(join(dir, 'b', 'x.txt'));
    expect(await findFile(dir, () => false)).toBeNull();
    expect(urlFileName('https://h/p/NotoSansKR%5Bwght%5D.ttf?x=1')).toBe('NotoSansKR[wght].ttf');
    expect(urlFileName('https://h/')).toBe('download');
    for (const bad of ['https://h/x/..%2F..%2Fevil.zip', 'https://h/x/a%5Cb.zip', 'https://h/x/a%00b', 'https://h/x/%E0%A4%A']) {
      expect(() => urlFileName(bad)).toThrow(bad);
    }
    expect(byteCompare('B', 'a')).toBeLessThan(0);
    expect(archiveKind('a.ZIP')).toBe('zip');
    expect(archiveKind('a.tpz')).toBe('zip');
    expect(archiveKind('a.tar.xz')).toBe('tar');
    expect(archiveKind('a.tgz')).toBe('tar');
    expect(archiveKind('a.dmg')).toBe('dmg');
    expect(archiveKind('a.whl')).toBeNull();
    expect(archiveKind('a.tar')).toBe('tar');
    expect(archiveKind('a.TAR.BZ2')).toBe('tar');
    expect(archiveKind('a.txz')).toBe('tar');
    expect(archiveKind('a.tar.gz.sig')).toBeNull();
    expect(archiveKind('a.zip.sig')).toBeNull();
  });

  it('extracts zip and tar archives and refuses other files', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-extract-'));
    mkdirSync(join(dir, 'src', 'inner'), { recursive: true });
    writeFileSync(join(dir, 'src', 'inner', 'f.txt'), 'f');
    sh(join(dir, 'src'), 'zip', ['-qr', join(dir, 'a.zip'), 'inner']);
    sh(join(dir, 'src'), 'tar', ['-czf', join(dir, 'a.tar.gz'), 'inner']);
    const log = join(dir, 'log');
    const bin = fakeBin(join(dir, 'bin'), { tar: `echo "tar $*" >> ${log}\nexec /usr/bin/tar "$@"`, unzip: `echo "unzip $*" >> ${log}\nexec /usr/bin/unzip "$@"` });
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin`, OGW_HOST_PLATFORM: 'macos-arm64' };
    await extractArchive(join(dir, 'a.zip'), join(dir, 'z', 'deep'), env);
    await extractArchive(join(dir, 'a.tar.gz'), join(dir, 't', 'deep'), env);
    await extractArchive(join(dir, 'a.zip'), join(dir, 'w'), { ...env, OGW_HOST_PLATFORM: 'windows-x64' });
    expect(readFileSync(join(dir, 'z', 'deep', 'inner', 'f.txt'), 'utf8')).toBe('f');
    expect(readFileSync(join(dir, 't', 'deep', 'inner', 'f.txt'), 'utf8')).toBe('f');
    expect(readFileSync(join(dir, 'w', 'inner', 'f.txt'), 'utf8')).toBe('f');
    expect(readFileSync(log, 'utf8')).toBe(
      [
        `unzip -q -o ${join(dir, 'a.zip')} -d ${join(dir, 'z', 'deep')}`,
        `tar -xf ${join(dir, 'a.tar.gz')} -C ${join(dir, 't', 'deep')}`,
        `tar -xf ${join(dir, 'a.zip')} -C ${join(dir, 'w')}`,
        '',
      ].join('\n'),
    );
    await expect(extractArchive(join(dir, 'src', 'inner', 'f.txt'), join(dir, 'n'), process.env)).rejects.toThrow('not an archive');
  });

  it('extracts a dmg with hdiutil and ditto, leaving out its links such as the /Applications shortcut', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ogw-dmg-'));
    const log = join(dir, 'log');
    // the Blender dmg names its /Applications shortcut " "
    const bin = fakeBin(join(dir, 'bin'), {
      hdiutil: `echo "$@" >> ${log}\nif [ "$1" = attach ]; then mkdir -p "$5/Blender.app" "$5/.hidden"; ln -s /Applications "$5/Applications"; ln -s /Applications "$5/ "; fi`,
      ditto: `mkdir -p "$2" && echo copied > "$2/marker"`,
    });
    const env = { ...process.env, PATH: `${bin}:/usr/bin:/bin` };
    writeFileSync(join(dir, 'b.dmg'), 'dmg');
    await extractArchive(join(dir, 'b.dmg'), join(dir, 'out'), env);
    expect(readFileSync(join(dir, 'out', 'Blender.app', 'marker'), 'utf8')).toBe('copied\n');
    const calls = readFileSync(log, 'utf8');
    expect(calls).toContain('attach -nobrowse -readonly -mountpoint');
    expect(calls).toContain('detach');
    expect(await listFiles(join(dir, 'out'))).toEqual(['Blender.app/marker']);
    expect(calls.split('\n').filter((l) => l.startsWith('detach'))).toHaveLength(1);
    expect(readdirSync(join(dir, 'out')).filter((name) => name.startsWith('.mount-'))).toEqual([]);
  });
});

describe('host', () => {
  it('names the host platform', () => {
    expect(hostPlatformOf('darwin', 'arm64')).toBe('macos-arm64');
    expect(hostPlatformOf('linux', 'x64')).toBe('linux-x64');
    expect(hostPlatformOf('win32', 'x64')).toBe('windows-x64');
    expect(hostPlatformOf('darwin', 'x64')).toBeNull();
    expect(hostPlatform({ OGW_HOST_PLATFORM: 'linux-x64' })).toBe('linux-x64');
    expect(hostPlatform({ OGW_HOST_PLATFORM: 'other' })).toBe(hostPlatformOf(process.platform, process.arch));
  });

  it('finds temp, result and data folders and programs', async () => {
    expect(safeSegment('Noto Sans KR google/fonts')).toBe('Noto_Sans_KR_google_fonts');
    expect(safeSegment('..')).toBe('_');
    expect(safeSegment('')).toBe('_');
    expect(safeSegment('4.5.1.stable')).toBe('4.5.1.stable');
    const ws = makeWorkspace();
    const ctx = createContext({ cwd: ws.root, env: ws.env, stdin: () => Promise.resolve(''), stderr: () => undefined });
    expect(await dataDir(ctx)).toBe(join(ws.root, '.ogw'));
    expect(await envResultPath(ws.env, 'env-check')).toBe(join(await privateTempDir(ws.env), 'ogw-env', 'env-check.json'));
    expect(await privateTempDir(ws.env)).toBe(join(await commonDir(ws.harness), 'ogw-temp'));
    const bin = fakeBin(join(ws.root, 'bin'), { tool: 'true' });
    writeFileSync(join(bin, 'plain'), '');
    expect(await whichIn({ PATH: `/nowhere:${bin}` }, 'tool')).toBe(join(bin, 'tool'));
    expect(await whichIn({ PATH: bin }, 'plain')).toBeNull();
    expect(await whichIn({}, 'tool')).toBeNull();
    expect(await whichIn({ Path: bin }, 'tool')).toBe(join(bin, 'tool'));
    const winTool = join(bin, 'wintool.CMD');
    writeFileSync(winTool, '');
    chmodSync(winTool, 0o755);
    expect(await whichIn({ PATH: bin, PATHEXT: '.EXE;.CMD' }, 'wintool', 'win32')).toBe(winTool);
    expect(await whichIn({ PATH: bin }, 'wintool', 'win32')).toBe(winTool);
    expect(await whichIn({ PATH: bin, PATHEXT: '.EXE' }, 'wintool', 'win32')).toBeNull();
    expect(await whichIn({ PATH: bin }, 'wintool')).toBeNull();
  });
});
