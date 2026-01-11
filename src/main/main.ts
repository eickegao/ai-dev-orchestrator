import { app, BrowserWindow, dialog, ipcMain } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { spawn } from "node:child_process";

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

    const child = spawn("git", ["status", "-sb"], { cwd: workspacePath });

    const sendChunk = (source: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      outputStream.write(text);
      event.sender.send("run:output", { runId, source, text });
    };

    child.stdout.on("data", (chunk) => sendChunk("stdout", chunk));
    child.stderr.on("data", (chunk) => sendChunk("stderr", chunk));

    child.on("close", async (code) => {
      const endTime = new Date().toISOString();
      outputStream.end();

      const runMeta = {
        run_id: runId,
        workspacePath,
        command,
        startTime,
        endTime,
        exitCode: code ?? -1
      };

      await fs.promises.writeFile(
        path.join(runDir, "run.json"),
        JSON.stringify(runMeta, null, 2),
        "utf-8"
      );

      event.sender.send("run:done", { runId, exitCode: code ?? -1 });
    });

    child.on("error", async (error) => {
      const endTime = new Date().toISOString();
      outputStream.end();

      const runMeta = {
        run_id: runId,
        workspacePath,
        command,
        startTime,
        endTime,
        exitCode: -1,
        error: error.message
      };

      await fs.promises.writeFile(
        path.join(runDir, "run.json"),
        JSON.stringify(runMeta, null, 2),
        "utf-8"
      );

      event.sender.send("run:done", { runId, exitCode: -1 });
    });

    return runId;
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
