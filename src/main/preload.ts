import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("appInfo", {
  version: process.versions.electron,
  platform: process.platform
});

contextBridge.exposeInMainWorld("api", {
  selectWorkspace: async () => ipcRenderer.invoke("workspace:select"),
  runPlan: async (payload: { workspacePath: string; plan: { plan_name: string; steps: Array<{ type: "cmd"; command: string } | { type: "note"; text: string }> } }) =>
    ipcRenderer.invoke("run:plan", payload),
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
  }
});
