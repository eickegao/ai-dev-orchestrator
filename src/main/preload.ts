import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("appInfo", {
  version: process.versions.electron,
  platform: process.platform
});

contextBridge.exposeInMainWorld("api", {
  selectWorkspace: async () => ipcRenderer.invoke("workspace:select"),
  runGitStatus: async (workspacePath: string) =>
    ipcRenderer.invoke("run:git-status", workspacePath),
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
  }
});
