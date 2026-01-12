import { contextBridge, ipcRenderer } from "electron";
import type { TaskPlan } from "../shared/protocol";

contextBridge.exposeInMainWorld("appInfo", {
  version: process.versions.electron,
  platform: process.platform
});

contextBridge.exposeInMainWorld("api", {
  selectWorkspace: async () => ipcRenderer.invoke("workspace:select"),
  runPlan: async (payload: {
    workspacePath: string;
    plan: TaskPlan;
    requirement?: string;
    allowDirtyVerifyOnly?: boolean;
  }) =>
    ipcRenderer.invoke("run:plan", payload) as Promise<{
      ok: true;
      result: string;
    } | {
      ok: false;
      error: {
        code: string;
        name: string;
        message: string;
        details?: {
          dirty_files?: string[];
          allow_verify_only_supported?: boolean;
        };
      };
    }>,
  startAutobuild: async (payload: { workspace: string; requirement: string; maxIterations?: number }) =>
    ipcRenderer.invoke("autobuild:start", payload),
  cancelAutobuild: async () => ipcRenderer.invoke("autobuild:cancel"),
  generatePlan: async (requirement: string) => ipcRenderer.invoke("planner:generatePlan", requirement),
  cancelRun: async (runId: string) => ipcRenderer.invoke("run:cancel", runId),
  submitDecision: async (payload: { runId: string; result: "approved" | "rejected" }) =>
    ipcRenderer.invoke("run:decision", payload),
  getRunsRoot: async () => ipcRenderer.invoke("runs:root"),
  onRunOutput: (callback: (payload: { runId: string; source: string; text: string }) => void) => {
    const listener = (_event: unknown, payload: { runId: string; source: string; text: string }) => {
      callback(payload);
    };
    ipcRenderer.on("run:output", listener);
    return () => ipcRenderer.removeListener("run:output", listener);
  },
  onRunDone: (callback: (payload: { runId: string; exitCode: number }) => void) => {
    const listener = (_event: unknown, payload: { runId: string; exitCode: number }) => {
      callback(payload);
    };
    ipcRenderer.on("run:done", listener);
    return () => ipcRenderer.removeListener("run:done", listener);
  },
  onRunStep: (callback: (payload: { runId: string; stepIndex: number; total: number }) => void) => {
    const listener = (_event: unknown, payload: { runId: string; stepIndex: number; total: number }) => {
      callback(payload);
    };
    ipcRenderer.on("run:step", listener);
    return () => ipcRenderer.removeListener("run:step", listener);
  },
  onRunCancelled: (callback: (payload: { runId: string }) => void) => {
    const listener = (_event: unknown, payload: { runId: string }) => {
      callback(payload);
    };
    ipcRenderer.on("run:cancelled", listener);
    return () => ipcRenderer.removeListener("run:cancelled", listener);
  },
  onDecisionRequired: (callback: (payload: { runId: string; files: string[] }) => void) => {
    const listener = (_event: unknown, payload: { runId: string; files: string[] }) => {
      callback(payload);
    };
    ipcRenderer.on("run:decision", listener);
    return () => ipcRenderer.removeListener("run:decision", listener);
  },
  onAutobuildStatus: (
    callback: (payload: {
      iteration: number;
      phase: "planning" | "running" | "done";
      message: string;
      run_id?: string;
    }) => void
  ) => {
    const listener = (
      _event: unknown,
      payload: { iteration: number; phase: "planning" | "running" | "done"; message: string; run_id?: string }
    ) => {
      callback(payload);
    };
    ipcRenderer.on("autobuild:status", listener);
    return () => ipcRenderer.removeListener("autobuild:status", listener);
  },
  onAutobuildPlan: (callback: (payload: { iteration: number; plan: TaskPlan; plan_name: string }) => void) => {
    const listener = (_event: unknown, payload: { iteration: number; plan: TaskPlan; plan_name: string }) => {
      callback(payload);
    };
    ipcRenderer.on("autobuild:plan", listener);
    return () => ipcRenderer.removeListener("autobuild:plan", listener);
  },
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
  ) => {
    const listener = (
      _event: unknown,
      payload: {
        stop_reason: string;
        iterations_run: number;
        per_iteration_summary: Array<{
          iteration: number;
          plan_name: string;
          run_id: string;
          outcome: string;
          evaluation_brief: string;
        }>;
      }
    ) => {
      callback(payload);
    };
    ipcRenderer.on("autobuild:done", listener);
    return () => ipcRenderer.removeListener("autobuild:done", listener);
  }
});
