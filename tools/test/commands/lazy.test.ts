import { describe, expect, it } from 'vitest';
import { commands } from '../../src/commands/index.ts';
import { COMMAND_FOLDERS, commandsFor } from '../../src/commands/lazy.ts';

describe('lazy command folders', () => {
  it('loads, for each first word, exactly the commands of that word, and every command has a folder', async () => {
    const words = [...new Set(commands.map((c) => c.name[0]))].sort();
    expect(Object.keys(COMMAND_FOLDERS).sort()).toEqual(words);
    for (const word of words) {
      const loaded = await commandsFor(word);
      expect(loaded.map((c) => c.name.join(' '))).toEqual(commands.filter((c) => c.name[0] === word).map((c) => c.name.join(' ')));
    }
  });

  it('gives every command for a word that names no folder, and none to the job supervisor', async () => {
    expect(await commandsFor('nope')).toBe(commands);
    expect(await commandsFor(undefined)).toBe(commands);
    expect(await commandsFor('__job-supervise')).toEqual([]);
  });
});
