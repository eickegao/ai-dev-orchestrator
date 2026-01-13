/// <reference types="vite/client" />

declare global {
  interface Window {
    appInfo: {
      version: string;
      platform: string;
    };
    api?: {
      selectWorkspace: () => Promise<string | null>;
      checkPlanExists: (workspacePath: string) => Promise<boolean>;
      createSamplePlan: (workspacePath: string) => Promise<{ created: boolean; path: string }>;
      runPlan: (payload: { workspacePath: string; planPath?: string }) => Promise<
        | { ok: true; result: string }
        | {
            ok: false;
            error: {
              code: string;
              name: string;
              message: string;
            };
          }
      >;
      cancelRun: (runId: string) => Promise<boolean>;
      getRunsRoot: () => Promise<string>;
      onRunOutput: (
        callback: (payload: { runId: string; source: "stdout" | "stderr" | "system"; text: string }) => void
      ) => () => void;
      onRunDone: (callback: (payload: { runId: string; exitCode: number }) => void) => () => void;
      onRunStep: (callback: (payload: { runId: string; stepIndex: number; total: number }) => void) => () => void;
      onRunCancelled: (callback: (payload: { runId: string }) => void) => () => void;
    };
  }
}

export {};
