// Global setup of the test run: ogw code called with an env without `OGW_HARNESS_ROOT` puts its private temp and
// secret folders into the git dir of the real harness repo. The run fails when such a folder appeared or changed
// during it; the fix is a `makeWorkspace()` env for the ogw code the test calls.
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const realHarness = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const FOLDERS = ['ogw-temp', 'ogw-secret-files'];

function gitDir(): string {
  return resolve(realHarness, execFileSync('git', ['-C', realHarness, 'rev-parse', '--git-common-dir'], { encoding: 'utf8' }).trim());
}

/** Change time of each folder, or null when it does not exist. */
function stamps(dir: string): (number | null)[] {
  return FOLDERS.map((name) => {
    try {
      return statSync(join(dir, name)).mtimeMs;
    } catch {
      return null;
    }
  });
}

export default function setup(): () => void {
  const dir = gitDir();
  const before = stamps(dir);
  return () => {
    const after = stamps(dir);
    const touched = FOLDERS.filter((_, i) => after[i] !== before[i]).map((name) => join(dir, name));
    if (touched.length > 0) {
      throw new Error(`a test wrote to ${touched.join(', ')} of the real harness repo (or an ogw command ran during the tests): give the ogw code it calls a makeWorkspace() env`);
    }
  };
}
