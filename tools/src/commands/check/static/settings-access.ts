import { at, finding, type Finding, type StaticContext } from './lib/context.ts';
import { isClientContentGd, isClientDev, isServerContentTs } from './lib/files.ts';
import { lineOf, stringText, tsSource, walkTs } from './lib/ts-source.ts';

/**
 * settings access: client content code (outside `client/dev/`) uses `CoreSettings`, `settings.json`, `core_settings.json`;
 * server content code uses `settings.json`, `core-settings.json`.
 */
export const NAME = 'settings access';

const CLIENT_FILES = ['settings.json', 'core_settings.json'];
const SERVER_FILES = ['settings.json', 'core-settings.json'];

async function clientFindings(sc: StaticContext, path: string): Promise<Finding[]> {
  const file = await sc.gd(path);
  const out: Finding[] = [];
  for (const t of file.tokens) {
    if (t.type === 'name' && t.text === 'CoreSettings') out.push(finding(NAME, at(path, t.line), '`CoreSettings`'));
    if (t.type === 'str') {
      const name = CLIENT_FILES.find((f) => t.value.includes(f));
      if (name) out.push(finding(NAME, at(path, t.line), `\`${name}\``));
    }
  }
  return out;
}

async function serverFindings(sc: StaticContext, path: string): Promise<Finding[]> {
  const source = await tsSource(sc, path);
  const out: Finding[] = [];
  walkTs(source, (node) => {
    const text = stringText(node);
    if (text === null) return;
    const name = SERVER_FILES.find((f) => text.includes(f));
    if (name) out.push(finding(NAME, at(path, lineOf(source, node)), `\`${name}\``));
  });
  return out;
}

export async function run(sc: StaticContext): Promise<Finding[]> {
  const client = sc.filter((p) => isClientContentGd(p) && !isClientDev(p)).map((p) => clientFindings(sc, p));
  const server = sc.filter(isServerContentTs).map((p) => serverFindings(sc, p));
  return (await Promise.all([...client, ...server])).flat();
}
