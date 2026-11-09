/** The worker thread of the glb tests that time `uvOverlap` (`inWorker`): it posts `uvOverlap` of the GLB bytes it gets. */
import { parentPort, workerData } from 'node:worker_threads';
import { readGlb, uvOverlap } from '../../../../src/commands/resource/lib/glb.ts';

parentPort?.postMessage(uvOverlap(readGlb(Buffer.from(workerData as Uint8Array), 'm'), 'm'));
