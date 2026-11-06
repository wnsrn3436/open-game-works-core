// Runs before each test file: the file gets its own temporary folder as TMPDIR (inherited by the processes its
// tests start), and the folder is removed when the file ends, so test runs leave nothing behind. `OGW_HOST_ID` gives
// every test the same host id (`TEST_HOST_ID` of workspace.ts), so no test reads the OS machine identifier.
// `OGW_TEST_REAL_GIT_DIR` makes ogw code that a test calls without a workspace env fail where it would write into the
// real harness repo.
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll } from 'vitest';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-t-')));
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = dir;
process.env.OGW_HOST_ID = '0123456789abcdef0123456789abcdef';
// the git dir of the real harness repo, where ogw code a test calls without a makeWorkspace() env would put its
// temporary and secret folders: that code stops there (`harnessGitFolder`), in this process and in the processes it starts
const realHarness = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
process.env.OGW_TEST_REAL_GIT_DIR = realpathSync(resolve(realHarness, execFileSync('git', ['-C', realHarness, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim()));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
