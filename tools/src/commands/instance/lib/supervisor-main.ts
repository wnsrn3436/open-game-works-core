// Entry of the detached supervisor process of an instance: `node supervisor-main.ts <instance id>`.
import { Supervisor } from './supervisor.ts';

const id = process.argv[2] ?? '';
const supervisor = new Supervisor(id, process.env);
const stop = (): void => {
  void supervisor.terminate();
};
process.once('SIGTERM', stop);
process.once('SIGINT', stop);
await supervisor.run();
process.off('SIGTERM', stop);
process.off('SIGINT', stop);
