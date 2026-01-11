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
      onRunOutput: (callback: (payload: { runId: string; source: string; text: string }) => void) => () => void;
      onRunDone: (callback: (payload: { runId: string; exitCode: number }) => void) => () => void;
    };
  }
}

export {};
