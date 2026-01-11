/// <reference types="vite/client" />

import type { TaskPlan } from "../shared/protocol";

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
        plan: TaskPlan;
        requirement?: string;
      }) => Promise<string>;
      generatePlan: (requirement: string) => Promise<TaskPlan>;
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
