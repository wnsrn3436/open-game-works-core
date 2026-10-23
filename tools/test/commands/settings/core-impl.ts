import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commitAll, type TestWorkspace } from '../../helpers/workspace.ts';
import { CORE_CONSTRAINTS, CORE_SCHEMA, CORE_SETTINGS } from './fixtures.ts';

function writeJson(path: string, value: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** `open-game-works-core-impl/settings/` and a `core-spec/` module file with the settings constraint, committed. */
export function writeCoreImpl(ws: TestWorkspace): void {
  writeJson(join(ws.coreImpl, 'settings', 'core-settings.json'), CORE_SETTINGS);
  writeJson(join(ws.coreImpl, 'settings', 'core-settings.schema.json'), CORE_SCHEMA);
  writeJson(join(ws.coreImpl, 'core-spec', 'NetworkCore.json'), { name: 'NetworkCore', side: 'client', settingsConstraints: CORE_CONSTRAINTS });
  writeJson(join(ws.coreImpl, 'core-spec', 'UICore.json'), { name: 'UICore', side: 'client' });
  writeFileSync(join(ws.coreImpl, 'core-spec', 'README.txt'), 'not a module\n');
  commitAll(ws.coreImpl, 'settings');
}
