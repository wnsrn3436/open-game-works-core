/** Values the mocked cross-group APIs return, set by each test. */
export const mockState = {
  modules: { client: [] as string[], server: [] as string[] },
  core: { 'QACore.commandTimeoutMs': 5000, 'QACore.videoMaxMs': 2000, 'QACore.feedbackWindowMs': 400 } as Record<string, unknown>,
  generateCalls: [] as string[],
  /** Lock paths the generate and data binary build mocks took. */
  generateLocks: [] as string[],
  dataCalls: [] as { root: string; binary: boolean; generate: boolean }[],
  dataExit: 0,
  engineVersion: '4.5.1.stable',
  enginePath: '',
  engineRequests: [] as [string, string][],
  ffmpeg: null as string | null,
  serverLaunches: [] as unknown[],
  populateFails: false,
  populateCalls: [] as unknown[],
};

export function resetMocks(): void {
  mockState.modules = { client: [], server: [] };
  mockState.core = { 'QACore.commandTimeoutMs': 5000, 'QACore.videoMaxMs': 2000, 'QACore.feedbackWindowMs': 400 };
  mockState.generateCalls = [];
  mockState.generateLocks = [];
  mockState.dataCalls = [];
  mockState.dataExit = 0;
  mockState.engineVersion = '4.5.1.stable';
  mockState.engineRequests = [];
  mockState.ffmpeg = null;
  mockState.serverLaunches = [];
  mockState.populateFails = false;
  mockState.populateCalls = [];
}
