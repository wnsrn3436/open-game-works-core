import { outsideJob } from '../../../../src/lib/spans.ts';

// Runs the instance supervisor in the test process instead of a detached process, outside the job of the start as a
// process of its own runs.
export function launchSupervisor(id: string, env: NodeJS.ProcessEnv): Promise<void> {
  outsideJob(() => {
    void import('../../../../src/commands/instance/lib/supervisor.ts').then(({ Supervisor }) => new Supervisor(id, env).run());
  });
  return Promise.resolve();
}
