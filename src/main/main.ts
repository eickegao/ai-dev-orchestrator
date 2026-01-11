import { app, BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const createWindow = () => {
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(app.getAppPath(), "dist/main/preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (app.isPackaged) {
    const indexPath = path.join(app.getAppPath(), "dist/renderer/index.html");
    window.loadURL(pathToFileURL(indexPath).toString());
  } else {
    window.loadURL("http://localhost:5173");
    window.webContents.openDevTools({ mode: "detach" });
  }
};

const RUN_TIMEOUT_MS = 30_000;
const ALLOWED_COMMAND_PREFIXES = ["git"];

const getRunsRoot = () => path.join(app.getPath("userData"), "ai-dev-orchestrator", "data", "runs");

const ensureRunDir = async (runId: string) => {
  const baseDir = path.join(getRunsRoot(), runId);
  await fs.promises.mkdir(baseDir, { recursive: true });
  return baseDir;
};

const isGitRepo = async (workspacePath: string) => {
  const gitPath = path.join(workspacePath, ".git");
  try {
    const stat = await fs.promises.stat(gitPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
};

const isCommandAllowed = (command: string) =>
  ALLOWED_COMMAND_PREFIXES.some((prefix) => command.startsWith(prefix));

type ActiveRun = {
  runId: string;
  workspacePath: string;
  command: string;
  startTime: string;
  runDir: string;
  outputStream: fs.WriteStream;
  child: ChildProcessWithoutNullStreams;
  timeoutId: NodeJS.Timeout;
  cancelled: boolean;
  timedOut: boolean;
};

let activeRun: ActiveRun | null = null;

const writeRunMeta = async (runDir: string, meta: Record<string, unknown>) => {
  await fs.promises.writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify(meta, null, 2),
    "utf-8"
  );
};

const appendSystemLog = (sender: WebContents, runId: string, outputStream: fs.WriteStream, text: string) => {
  outputStream.write(text);
  sender.send("run:output", { runId, source: "system", text });
};

const terminateProcess = (child: ChildProcessWithoutNullStreams) => {
  child.kill("SIGTERM");
  const killTimer = setTimeout(() => {
    if (!child.killed) {
      child.kill("SIGKILL");
    }
  }, 3_000);
  child.once("exit", () => clearTimeout(killTimer));
};

const registerIpc = () => {
  ipcMain.handle("workspace:select", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openDirectory"]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return null;
    }

    return result.filePaths[0];
  });

  ipcMain.handle("runs:root", async () => {
    const runsRoot = getRunsRoot();
    await fs.promises.mkdir(runsRoot, { recursive: true });
    return runsRoot;
  });

  ipcMain.handle("run:git-status", async (event, workspacePath: string) => {
    if (!workspacePath) {
      throw new Error("Workspace not set");
    }

    const isRepo = await isGitRepo(workspacePath);
    if (!isRepo) {
      throw new Error("Not a git repository (no .git found)");
    }

    const runId = String(Date.now());
    const startTime = new Date().toISOString();
    const command = "git status -sb";
    const runDir = await ensureRunDir(runId);
    const outputPath = path.join(runDir, "output.log");
    const outputStream = fs.createWriteStream(outputPath, { flags: "a" });

    if (!isCommandAllowed(command)) {
      appendSystemLog(event.sender, runId, outputStream, "Command not allowed by policy\n");
      const endTime = new Date().toISOString();
      await writeRunMeta(runDir, {
        run_id: runId,
        workspacePath,
        command,
        startTime,
        endTime,
        exitCode: -1,
        blocked_by_policy: true
      });
      outputStream.end();
      event.sender.send("run:done", { runId, exitCode: -1 });
      return runId;
    }

    const child = spawn("git", ["status", "-sb"], { cwd: workspacePath });
    const timeoutId = setTimeout(() => {
      if (!activeRun || activeRun.runId !== runId) return;
      activeRun.timedOut = true;
      appendSystemLog(event.sender, runId, outputStream, "[Timeout exceeded]\n");
      terminateProcess(child);
    }, RUN_TIMEOUT_MS);

    activeRun = {
      runId,
      workspacePath,
      command,
      startTime,
      runDir,
      outputStream,
      child,
      timeoutId,
      cancelled: false,
      timedOut: false
    };

    const sendChunk = (source: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      outputStream.write(text);
      event.sender.send("run:output", { runId, source, text });
    };

    child.stdout.on("data", (chunk) => sendChunk("stdout", chunk));
    child.stderr.on("data", (chunk) => sendChunk("stderr", chunk));

    child.on("close", async (code) => {
      const endTime = new Date().toISOString();
      if (activeRun?.runId === runId) {
        clearTimeout(activeRun.timeoutId);
      }
      outputStream.end();

      const runMeta = {
        run_id: runId,
        workspacePath,
        command,
        startTime,
        endTime,
        exitCode: code ?? -1,
        cancelled: activeRun?.cancelled ?? false,
        timeout: activeRun?.timedOut ?? false
      };

      await writeRunMeta(runDir, runMeta);

      event.sender.send("run:done", { runId, exitCode: code ?? -1 });
      if (activeRun?.runId === runId) {
        activeRun = null;
      }
    });

    child.on("error", async (error) => {
      const endTime = new Date().toISOString();
      if (activeRun?.runId === runId) {
        clearTimeout(activeRun.timeoutId);
      }
      outputStream.end();

      const runMeta = {
        run_id: runId,
        workspacePath,
        command,
        startTime,
        endTime,
        exitCode: -1,
        error: error.message,
        cancelled: activeRun?.cancelled ?? false,
        timeout: activeRun?.timedOut ?? false
      };

      await writeRunMeta(runDir, runMeta);

      event.sender.send("run:done", { runId, exitCode: -1 });
      if (activeRun?.runId === runId) {
        activeRun = null;
      }
    });

    return runId;
  });

  ipcMain.handle("run:cancel", async (event, runId: string) => {
    if (!activeRun || activeRun.runId !== runId) {
      return false;
    }
    activeRun.cancelled = true;
    appendSystemLog(event.sender, runId, activeRun.outputStream, "[Cancelled by user]\n");
    terminateProcess(activeRun.child);
    event.sender.send("run:cancelled", { runId });
    return true;
  });
};

app.whenReady().then(() => {
  registerIpc();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
