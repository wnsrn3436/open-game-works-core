import { describe, expect, it } from 'vitest';
import { internalImportFindings } from '../../../../src/commands/core/lib/core-server-imports.ts';

const NAMED = new Set(['server-time/scheduler.ts', '*/dev/adapters/fake.ts']);

describe('server core internal imports', () => {
  it('allows the entry file, dev/index.ts from a dev file, a named path, the own module, testing and core tests', () => {
    const text = (spec: string): string => `import { a } from '${spec}';\n`;
    expect(internalImportFindings('chat/index.ts', text('../storage/index.ts'), NAMED)).toEqual([]);
    expect(internalImportFindings('chat/dev/ops.ts', text('../../storage/dev/index.ts'), NAMED)).toEqual([]);
    expect(internalImportFindings('chat/index.ts', text('../server-time/scheduler.ts'), NAMED)).toEqual([]);
    expect(internalImportFindings('chat/index.ts', text('./rooms.ts'), NAMED)).toEqual([]);
    expect(internalImportFindings('chat/dev/index.ts', text('../../push/dev/adapters/fake.ts'), NAMED)).toEqual([]);
    expect(internalImportFindings('testing/dev/index.ts', text('../../storage/db/pg_protocol.ts'), NAMED)).toEqual([]);
    expect(internalImportFindings('chat/tests/a.test.ts', text('../../storage/tx.ts'), NAMED)).toEqual([]);
    expect(internalImportFindings('chat/index.ts', text('node:fs'), NAMED)).toEqual([]);
  });

  it('does not check a file directly under server/core/, which is in no module folder', () => {
    expect(internalImportFindings('start.ts', "import { x } from './routing/server.ts';\n", NAMED)).toEqual([]);
  });

  it('reports an internal file of another module, type imports, re-exports and dev/index.ts outside dev', () => {
    const finding = (file: string, target: string, other: string): string =>
      `server/core/${file}: internal import: \`${target}\` is an internal file of \`${other}\`; import its entry file or a file the spec names`;
    expect(internalImportFindings('matchmaker/shared.ts', "import type { LogFields } from '../logging/log_line.ts';\n", NAMED)).toEqual([finding('matchmaker/shared.ts', 'logging/log_line.ts', 'logging')]);
    expect(internalImportFindings('chat/index.ts', "export { x } from '../storage/tx.ts';\n", NAMED)).toEqual([finding('chat/index.ts', 'storage/tx.ts', 'storage')]);
    expect(internalImportFindings('chat/index.ts', "import { x } from '../storage/dev/index.ts';\n", NAMED)).toEqual([finding('chat/index.ts', 'storage/dev/index.ts', 'storage')]);
  });

});
