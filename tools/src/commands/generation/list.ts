import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { expectPositionals, positional, type CommandDef, type Context } from '../../lib/command.ts';
import { OgwError } from '../../lib/errors.ts';
import { exists } from '../../lib/fsx.ts';
import { listFiles } from '../env/lib/files.ts';
import { methodMarker, type MethodMarker } from './lib/install.ts';

export interface CatalogFile {
  path: string;
  license: string;
  source: string;
  attribution: string;
  charset: string[];
}

/** google/fonts `METADATA.pb` license names as SPDX IDs. */
const LICENSES: Record<string, string> = { OFL: 'OFL-1.1', APACHE2: 'Apache-2.0', UFL: 'UFL-1.0' };

interface FamilyMetadata {
  license: string;
  subsets: string[];
  copyright: Map<string, string>;
}

/** Reads the fields of a google/fonts `METADATA.pb` text proto that the catalog list needs. */
export function parseMetadata(text: string): FamilyMetadata {
  const license = /^license:\s*"([^"]*)"/m.exec(text)?.[1] ?? '';
  const subsets = [...text.matchAll(/^subsets:\s*"([^"]*)"/gm)].map((m) => m[1] as string);
  const copyright = new Map<string, string>();
  for (const block of text.matchAll(/^fonts\s*\{([\s\S]*?)^\}/gm)) {
    const body = block[1] as string;
    const filename = /filename:\s*"([^"]*)"/.exec(body)?.[1];
    const notice = /copyright:\s*"((?:[^"\\]|\\.)*)"/.exec(body)?.[1];
    if (filename !== undefined && notice !== undefined) copyright.set(filename, notice.replace(/\\(.)/g, '$1'));
  }
  return { license: LICENSES[license] ?? 'unknown', subsets, copyright };
}

/** Source URL of a file in a GitHub repository at a revision; other git hosts have no known file URL form. */
export function sourceUrl(repository: string, revision: string, path: string): string {
  const github = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(\.git)?\/?$/.exec(repository);
  if (!github) throw new OgwError(`no source URL for a file of git repository ${repository}: only https://github.com/<owner>/<repo> repositories have one`);
  return `https://github.com/${github[1] as string}/blob/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

/** Source URL of a file in a Hugging Face repository at a revision. */
export function hfSourceUrl(repository: string, revision: string, path: string): string {
  return `https://huggingface.co/${repository}/blob/${revision}/${path.split('/').map(encodeURIComponent).join('/')}`;
}

const FONT = /\.(ttf|otf)$/i;

type Plain = (path: string, source: string) => CatalogFile;

/** Files of one git checkout without `.git/`; in a folder with a google/fonts `METADATA.pb`, only its font files. */
async function gitEntries(repo: MethodMarker['git'][number], plain: Plain): Promise<CatalogFile[]> {
  const files: CatalogFile[] = [];
  const metadata = new Map<string, FamilyMetadata | null>();
  for (const rel of (await listFiles(repo.dir)).filter((p) => !p.startsWith('.git/'))) {
    const folder = dirname(rel);
    if (!metadata.has(folder)) {
      const metadataPath = join(repo.dir, folder, 'METADATA.pb');
      metadata.set(folder, exists(metadataPath) ? parseMetadata(await readFile(metadataPath, 'utf8')) : null);
    }
    const family = metadata.get(folder) ?? null;
    const source = sourceUrl(repo.source, repo.revision, rel);
    if (family === null) files.push(plain(join(repo.dir, rel), source));
    else if (FONT.test(rel)) {
      const fileName = rel.slice(rel.lastIndexOf('/') + 1);
      files.push({ path: join(repo.dir, rel), license: family.license, source, attribution: family.copyright.get(fileName) ?? '', charset: family.subsets });
    }
  }
  return files;
}

/**
 * Files a catalog method installed, with license, source URL, attribution and character set (`ogw generation list`):
 * every file of its git checkouts (without `.git/`), hf folders and `file` pins. In a folder with a google/fonts
 * `METADATA.pb` only the font files are catalog files, and their license, attribution and character set come from
 * it; other files get the method `license` (`unknown` without one) and `attribution`, and no character set.
 */
export async function catalogEntries(ctx: Context, name: string): Promise<CatalogFile[]> {
  const method = (await ctx.settings()).resourceGeneration.find((m) => m.name === name);
  if (method?.kind !== 'catalog') throw new OgwError(`${name} is not a catalog method of harness settings resourceGeneration`);
  const marker = await methodMarker(ctx, method);
  if (!marker) throw new OgwError(`method ${name} is not installed as pinned on this host: the update env command installs it`);
  const attribution = typeof method.attribution === 'string' ? method.attribution : '';
  const plain: Plain = (path, source) => ({ path, license: method.license ?? 'unknown', source, attribution, charset: [] });
  const files: CatalogFile[] = [];
  for (const repo of marker.git) files.push(...(await gitEntries(repo, plain)));
  const pins = method.pins ?? [];
  const hfPins = pins.filter((p) => p.kind === 'hf');
  for (const [index, hf] of marker.hf.entries()) {
    const revision = hfPins[index]?.revision ?? '';
    for (const rel of await listFiles(hf.dir)) files.push(plain(join(hf.dir, rel), hfSourceUrl(hf.source, revision, rel)));
  }
  const folder = marker.files;
  if (folder !== null) files.push(...pins.filter((p) => p.kind === 'file').map((pin) => plain(join(folder, pin.files ?? pin.source), pin.url ?? '')));
  return files;
}

export const listCommand: CommandDef = {
  name: ['generation', 'list'],
  usage: 'ogw generation list <method>',
  async run(ctx, args) {
    expectPositionals(args, 1, 1, this.usage);
    const files = await catalogEntries(ctx, positional(args, 0, 'method'));
    const text = files.map((f) => `${f.path}\n  license ${f.license}\n  source ${f.source}\n  attribution ${f.attribution}\n  charset ${f.charset.join(', ')}`);
    return { text: files.length === 0 ? 'none' : text.join('\n'), data: { files } };
  },
};
