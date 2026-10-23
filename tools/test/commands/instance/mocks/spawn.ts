// Runs the instance supervisor in the test process instead of a detached process.
export function launchSupervisor(id: string, env: NodeJS.ProcessEnv): Promise<void> {
  void import('../../../../src/commands/instance/lib/supervisor.ts').then(({ Supervisor }) => new Supervisor(id, env).run());
  return Promise.resolve();
}
