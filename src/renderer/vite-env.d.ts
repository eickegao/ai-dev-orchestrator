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
      startAutobuild: (payload: {
        workspace: string;
        requirement: string;
        maxIterations?: number;
      }) => Promise<boolean>;
      cancelAutobuild: () => Promise<boolean>;
      generatePlan: (requirement: string) => Promise<TaskPlan>;
      cancelRun: (runId: string) => Promise<boolean>;
      submitDecision: (payload: { runId: string; result: "approved" | "rejected" }) => Promise<boolean>;
      getRunsRoot: () => Promise<string>;
      onRunOutput: (callback: (payload: { runId: string; source: "stdout" | "stderr" | "system"; text: string }) => void) => () => void;
      onRunDone: (callback: (payload: { runId: string; exitCode: number }) => void) => () => void;
      onRunStep: (callback: (payload: { runId: string; stepIndex: number; total: number }) => void) => () => void;
      onRunCancelled: (callback: (payload: { runId: string }) => void) => () => void;
      onDecisionRequired: (callback: (payload: { runId: string; files: string[] }) => void) => () => void;
      onAutobuildStatus: (
        callback: (payload: { iteration: number; phase: "planning" | "running" | "done"; message: string }) => void
      ) => () => void;
      onAutobuildPlan: (callback: (payload: { iteration: number; plan: TaskPlan }) => void) => () => void;
      onAutobuildDone: (
        callback: (payload: { stop_reason: string; iterations_run: number }) => void
      ) => () => void;
    };
  }
}

export {};
