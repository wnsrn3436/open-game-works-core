import { join } from 'node:path';
import { OgwError } from '../../../lib/errors.ts';
import { readText } from '../../../lib/fsx.ts';
import { harnessRoot } from '../../../lib/paths.ts';

export interface ProdOrders {
  deploy: string[];
  rollback: string[];
  maintenance: string;
}

/** Marker texts in `build` `## deploy`. */
const DEPLOY_MARKER = 'A human deploys PROD';
const ROLLBACK_MARKER = 'also carries the rollback order below';
const MAINTENANCE_MARKER = 'also carries the maintenance order: ';

function numberedAfter(lines: readonly string[], marker: string): string[] {
  const start = lines.findIndex((line) => line.includes(marker));
  if (start === -1) throw new OgwError(`not defined: "${marker}" in skills/build/SKILL.md ## deploy`);
  const steps: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\d+\. /.test(line)) steps.push(line.replace(/^\d+\. /, ''));
    else if (steps.length > 0) break;
  }
  if (steps.length === 0) throw new OgwError(`not defined: steps after "${marker}" in skills/build/SKILL.md ## deploy`);
  return steps;
}

/** The PROD deploy order, rollback order and maintenance order exactly as `build` `## deploy` gives them. */
export async function readProdOrders(env: NodeJS.ProcessEnv): Promise<ProdOrders> {
  const text = await readText(join(harnessRoot(env), 'skills', 'build', 'SKILL.md'));
  const lines = text.split(/\r?\n/);
  const maintenanceLine = lines.find((line) => line.includes(MAINTENANCE_MARKER));
  if (maintenanceLine === undefined) {
    throw new OgwError('not defined: maintenance order in skills/build/SKILL.md ## deploy');
  }
  return {
    deploy: numberedAfter(lines, DEPLOY_MARKER),
    rollback: numberedAfter(lines, ROLLBACK_MARKER),
    maintenance: maintenanceLine.slice(maintenanceLine.indexOf(MAINTENANCE_MARKER) + MAINTENANCE_MARKER.length),
  };
}
