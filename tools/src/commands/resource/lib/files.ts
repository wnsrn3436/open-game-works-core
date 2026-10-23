import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isNotFound, writeFileAtomic } from '../../../lib/fsx.ts';

async function readOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
}

/** Planned file writes and deletes in a checkout, applied together and undone together. */
export class FileChanges {
  private readonly writes = new Map<string, Buffer>();
  private readonly deletes = new Set<string>();

  write(path: string, data: Buffer | string): void {
    this.deletes.delete(path);
    this.writes.set(path, typeof data === 'string' ? Buffer.from(data, 'utf8') : data);
  }

  delete(path: string): void {
    if (!this.writes.has(path)) this.deletes.add(path);
  }

  planned(path: string): Buffer | undefined {
    return this.writes.get(path);
  }

  /**
   * Applies the changes; files whose bytes do not change are not written. On a failure the files are restored.
   * Returns the changed paths and a function that restores every changed file.
   */
  async apply(root: string): Promise<{ changed: string[]; undo: () => Promise<void> }> {
    const originals = new Map<string, Buffer | null>();
    const undo = async (): Promise<void> => {
      for (const [path, data] of originals) {
        if (data === null) await rm(join(root, path), { force: true });
        else await writeFileAtomic(join(root, path), data);
      }
    };
    try {
      for (const [path, data] of this.writes) {
        const current = await readOrNull(join(root, path));
        if (current?.equals(data)) continue;
        originals.set(path, current);
        await writeFileAtomic(join(root, path), data);
      }
      for (const path of this.deletes) {
        const current = await readOrNull(join(root, path));
        if (current === null) continue;
        originals.set(path, current);
        await rm(join(root, path));
      }
    } catch (error) {
      await undo();
      throw error;
    }
    return { changed: [...originals.keys()].sort(), undo };
  }
}
