import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("appInfo", {
  version: process.versions.electron,
  platform: process.platform
});

contextBridge.exposeInMainWorld("api", {
  selectWorkspace: async () => ipcRenderer.invoke("workspace:select"),
  checkPlanExists: async (workspacePath: string) => ipcRenderer.invoke("plan:exists", workspacePath),
  createSamplePlan: async (workspacePath: string) => ipcRenderer.invoke("plan:createSample", workspacePath),
  runPlan: async (payload: { workspacePath: string; planPath?: string }) =>
    ipcRenderer.invoke("run:plan", payload) as Promise<
      | { ok: true; result: string }
      | {
          ok: false;
          error: {
            code: string;
            name: string;
            message: string;
          };
        }
    >,
  cancelRun: async (runId: string) => ipcRenderer.invoke("run:cancel", runId),
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
  }
});
