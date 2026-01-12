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
        allowDirtyVerifyOnly?: boolean;
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
        callback: (payload: {
          iteration: number;
          phase: "planning" | "running" | "done";
          message: string;
          run_id?: string;
        }) => void
      ) => () => void;
      onAutobuildPlan: (
        callback: (payload: { iteration: number; plan: TaskPlan; plan_name: string }) => void
      ) => () => void;
      onAutobuildDone: (
        callback: (payload: {
          stop_reason: string;
          iterations_run: number;
          per_iteration_summary: Array<{
            iteration: number;
            plan_name: string;
            run_id: string;
            outcome: string;
            evaluation_brief: string;
          }>;
        }) => void
      ) => () => void;
    };
  }
}

export {};
