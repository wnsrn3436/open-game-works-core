// Runs before each test file: the file gets its own temporary folder as TMPDIR (inherited by the processes its
// tests start), and the folder is removed when the file ends, so test runs leave nothing behind. `OGW_HOST_ID` gives
// every test the same host id (`TEST_HOST_ID` of workspace.ts), so no test reads the OS machine identifier.
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'ogw-t-')));
for (const name of ['TMPDIR', 'TMP', 'TEMP']) process.env[name] = dir;
process.env.OGW_HOST_ID = '0123456789abcdef0123456789abcdef';

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});
