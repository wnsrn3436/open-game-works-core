import { outsideJob } from '../../../../src/lib/spans.ts';

/** Runs before the supervisor of an instance starts, with its id; tests set it and reset it to null. */
export const supervisorHooks: { beforeRun: ((id: string, env: NodeJS.ProcessEnv) => Promise<void>) | null } = { beforeRun: null };

// Runs the instance supervisor in the test process instead of a detached process, outside the job of the start as a
// process of its own runs.
export async function launchSupervisor(id: string, env: NodeJS.ProcessEnv): Promise<void> {
  await supervisorHooks.beforeRun?.(id, env);
  outsideJob(() => {
    void import('../../../../src/commands/instance/lib/supervisor.ts').then(({ Supervisor }) => new Supervisor(id, env).run());
  });
}
