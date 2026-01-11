/// <reference types="vite/client" />

declare global {
  interface Window {
    appInfo: {
      version: string;
      platform: string;
    };
    api: {
      selectWorkspace: () => Promise<string | null>;
      runGitStatus: (workspacePath: string) => Promise<string>;
      cancelRun: (runId: string) => Promise<boolean>;
      getRunsRoot: () => Promise<string>;
      onRunOutput: (callback: (payload: { runId: string; source: "stdout" | "stderr" | "system"; text: string }) => void) => () => void;
      onRunDone: (callback: (payload: { runId: string; exitCode: number }) => void) => () => void;
      onRunCancelled: (callback: (payload: { runId: string }) => void) => () => void;
    };
  }
}

export {};
