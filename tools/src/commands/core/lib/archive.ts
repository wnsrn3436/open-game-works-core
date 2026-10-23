import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import yauzl from 'yauzl';
import yazl from 'yazl';
import { OgwError } from '../../../lib/errors.ts';

/** One file put into an archive: its path inside the archive (with `/`) and its file on disk. */
export interface ArchiveEntry {
  name: string;
  source: string;
}

function tempPath(path: string): string {
  return `${path}.tmp-${String(process.pid)}-${randomBytes(4).toString('hex')}`;
}

/** Writes a zip of `entries` through a temporary file and a rename. */
export async function writeZip(path: string, entries: readonly ArchiveEntry[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  try {
    const zip = new yazl.ZipFile();
    for (const entry of [...entries].sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)))) {
      zip.addFile(entry.source, entry.name, { mtime: new Date(0) });
    }
    zip.end();
    await pipeline(zip.outputStream, createWriteStream(tmp));
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** Writes a gzip tar of the files `names` (relative to `cwd`) through a temporary file and a rename. */
export async function writeTgz(path: string, cwd: string, names: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPath(path);
  try {
    const sorted = [...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    await tar.c({ gzip: true, file: tmp, cwd, portable: true, noDirRecurse: true, mtime: new Date(0) }, sorted);
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
}

/** True when an archive entry name stays inside the folder it is extracted to. */
export function isSafeEntryName(name: string): boolean {
  if (name === '' || isAbsolute(name) || /^[a-zA-Z]:/.test(name) || name.includes('\\')) return false;
  const normal = normalize(name);
  return normal !== '..' && !normal.startsWith(`..${sep}`);
}

function openZip(path: string): Promise<yauzl.ZipFile> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(path, { lazyEntries: true, autoClose: true }, (error, zip) => {
      if (error) reject(new OgwError(`cannot read zip ${path}: ${error.message}`));
      else resolvePromise(zip);
    });
  });
}

function entryStream(zip: yauzl.ZipFile, entry: yauzl.Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolvePromise, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error) reject(new OgwError(`cannot read ${entry.fileName}: ${error.message}`));
      else resolvePromise(stream);
    });
  });
}

async function extractZipInto(path: string, dest: string): Promise<void> {
  const zip = await openZip(path);
  await new Promise<void>((resolvePromise, reject) => {
    zip.on('error', (error: Error) => {
      reject(new OgwError(`cannot read zip ${path}: ${error.message}`));
    });
    zip.on('end', () => {
      resolvePromise();
    });
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        if (!isSafeEntryName(entry.fileName)) throw new OgwError(`unsafe path in zip ${path}: ${entry.fileName}`);
        const target = join(dest, entry.fileName);
        if (entry.fileName.endsWith('/')) {
          await mkdir(target, { recursive: true });
        } else {
          await mkdir(dirname(target), { recursive: true });
          await pipeline(await entryStream(zip, entry), createWriteStream(target));
        }
        zip.readEntry();
      })().catch(reject);
    });
    zip.readEntry();
  });
}

async function extractTgzInto(path: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  try {
    await tar.x({ file: path, cwd: dest, strict: true });
  } catch (error) {
    throw new OgwError(`cannot read tgz ${path}: ${(error as Error).message}`);
  }
}

/** Extracts a `.zip` or `.tgz` into `dest` (made through a temporary folder and a rename). */
export async function extractArchive(path: string, dest: string): Promise<void> {
  const tmp = tempPath(dest);
  try {
    await mkdir(tmp, { recursive: true });
    if (path.endsWith('.zip')) await extractZipInto(path, tmp);
    else if (path.endsWith('.tgz')) await extractTgzInto(path, tmp);
    else throw new OgwError(`not an archive asset: ${path}`);
    await rename(tmp, dest);
  } catch (error) {
    await rm(tmp, { recursive: true, force: true });
    throw error;
  }
}

/** Lower-case hex SHA-256 of a file. */
export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}
