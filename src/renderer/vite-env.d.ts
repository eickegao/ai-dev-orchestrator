/// <reference types="vite/client" />

declare global {
  interface Window {
    appInfo: {
      version: string;
      platform: string;
    };
    api?: {
      selectWorkspace: () => Promise<string | null>;
      runPlan: (payload: {
        workspacePath: string;
        plan: {
          plan_name: string;
          steps: Array<{ type: "cmd"; command: string } | { type: "note"; message: string }>;
        };
        requirement?: string;
      }) => Promise<string>;
      cancelRun: (runId: string) => Promise<boolean>;
      submitDecision: (payload: { runId: string; result: "approved" | "rejected" }) => Promise<boolean>;
      getRunsRoot: () => Promise<string>;
      onRunOutput: (callback: (payload: { runId: string; source: "stdout" | "stderr" | "system"; text: string }) => void) => () => void;
      onRunDone: (callback: (payload: { runId: string; exitCode: number }) => void) => () => void;
      onRunStep: (callback: (payload: { runId: string; stepIndex: number; total: number }) => void) => () => void;
      onRunCancelled: (callback: (payload: { runId: string }) => void) => () => void;
      onDecisionRequired: (callback: (payload: { runId: string; files: string[] }) => void) => () => void;
    };
  }
}

export {};
