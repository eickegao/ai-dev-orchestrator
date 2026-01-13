import { app, BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

const createWindow = () => {
  const preloadPath = path.join(__dirname, "preload.js");
  const window = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  if (app.isPackaged) {
    const indexPath = path.join(__dirname, "../renderer/index.html");
    window.loadURL(pathToFileURL(indexPath).toString());
  } else {
    window.loadURL("http://localhost:5173");
    window.webContents.openDevTools({ mode: "detach" });
  }
};

const RUN_TIMEOUT_MS = 30_000;
const ALLOWED_COMMAND_PREFIXES = ["git"];
const ALLOWED_EXECUTOR_TOOLS = new Set(["codex"]);

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

const isExecutorToolAllowed = (tool: string) => ALLOWED_EXECUTOR_TOOLS.has(tool);

const hasForbiddenShellOperators = (command: string) => {
  const forbidden = ["||", "&&", "|", ">", "<", ";", "$(", "`"];
  return forbidden.some((op) => command.includes(op));
};

type PlanStep =
  | { type: "cmd"; command: string }
  | { type: "note"; message: string }
  | { type: "executor"; tool: "codex"; instructions: string };

type TaskPlan = {
  plan_name: string;
  steps: PlanStep[];
};

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
  killGroup: boolean;
};

type ActivePlan = {
  runId: string;
  workspacePath: string;
  runDir: string;
  outputStream: fs.WriteStream;
  sender: WebContents;
  cancelled: boolean;
};

let activeRun: ActiveRun | null = null;
let activePlan: ActivePlan | null = null;

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

const terminateProcess = (child: ChildProcessWithoutNullStreams, killGroup = false) => {
  if (killGroup && child.pid && process.platform !== "win32") {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  } else {
    child.kill("SIGTERM");
  }
  const killTimer = setTimeout(() => {
    if (!child.killed) {
      if (killGroup && child.pid && process.platform !== "win32") {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
    }
  }, 3_000);
  child.once("exit", () => clearTimeout(killTimer));
};

const splitArgs = (command: string) => {
  const args: string[] = [];
  let current = "";
  let quote: "'" | "\"" | null = null;
  let escape = false;

  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (quote === "\"") {
      if (char === "\\") {
        escape = true;
        continue;
      }
      if (char === "\"") {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (quote === "'") {
      if (char === "'") {
        quote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }

    if (char === "\\") {
      escape = true;
      continue;
    }

    if (/\s/.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    args.push(current);
  }

  return args;
};

const parsePlanFile = async (filePath: string): Promise<TaskPlan> => {
  const raw = await fs.promises.readFile(filePath, "utf-8");
  const lines = raw.split(/\r?\n/);
  let planName = path.basename(filePath);
  let nameFromHeading = false;
  let inCodeBlock = false;
  const steps: PlanStep[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("```")) {
      inCodeBlock = !inCodeBlock;
      continue;
    }
    if (inCodeBlock) continue;

    const headingMatch = trimmed.match(/^#+\s+(.*)$/);
    if (headingMatch && !nameFromHeading) {
      const heading = headingMatch[1].trim();
      if (heading) {
        planName = heading;
        nameFromHeading = true;
      }
      continue;
    }

    const normalized = trimmed.replace(/^[-*]\s*/, "");
    const match = normalized.match(/^(cmd|note|executor)\s*:\s*(.+)$/i);
    if (match) {
      const type = match[1].toLowerCase();
      const value = match[2].trim();
      if (!value) continue;
      if (type === "cmd") {
        steps.push({ type: "cmd", command: value });
      } else if (type === "note") {
        steps.push({ type: "note", message: value });
      } else if (type === "executor") {
        steps.push({ type: "executor", tool: "codex", instructions: value });
      }
      continue;
    }

    steps.push({ type: "note", message: normalized });
  }

  if (steps.length === 0) {
    throw new Error(`Plan file has no steps: ${filePath}`);
  }

  return { plan_name: planName || "Plan", steps };
};

const runCommandCapture = (
  command: string,
  args: string[],
  cwd: string
): Promise<{ code: number; stdout: string; stderr: string; error?: string }> =>
  new Promise((resolve) => {
    const child = spawn(command, args, { cwd });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({ code: -1, stdout, stderr, error: error.message });
    });

    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });

const collectGitEvidence = async (
  workspacePath: string,
  sender: WebContents,
  runId: string,
  outputStream: fs.WriteStream
) => {
  if (!isCommandAllowed("git")) {
    const message = "Command not allowed by policy";
    appendSystemLog(sender, runId, outputStream, `--- evidence ---\n${message}\n`);
    return { error: message };
  }

  const commands = [
    { key: "git_status_porcelain", args: ["status", "--porcelain"], label: "git status --porcelain" },
    { key: "git_diff_stat", args: ["diff", "--stat"], label: "git diff --stat" },
    { key: "git_diff_name_only", args: ["diff", "--name-only"], label: "git diff --name-only" }
  ];

  const evidence: Record<string, string> = {};

  for (const command of commands) {
    const result = await runCommandCapture("git", command.args, workspacePath);
    if (result.code !== 0) {
      const reason = result.error ?? result.stderr.trim() ?? `exit code ${result.code}`;
      const message = `${command.label} failed: ${reason}`;
      appendSystemLog(sender, runId, outputStream, `--- evidence ---\n${message}\n`);
      return { error: message };
    }
    evidence[command.key] = result.stdout;
  }

  const evidenceLog = [
    "--- evidence ---",
    "git diff --stat:",
    evidence.git_diff_stat || "(no changes)",
    "git status --porcelain:",
    evidence.git_status_porcelain || "(clean)",
    "git diff --name-only:",
    evidence.git_diff_name_only || "(no changes)",
    ""
  ].join("\n");

  appendSystemLog(sender, runId, outputStream, evidenceLog);
  return evidence;
};

const runCommandStreaming = (
  command: string,
  args: string[],
  workspacePath: string,
  runId: string,
  sender: WebContents,
  outputStream: fs.WriteStream
) =>
  new Promise<{ exitCode: number; cancelled: boolean; timedOut: boolean; stdout: string; stderr: string }>(
    (resolve) => {
      const child = spawn(command, args, { cwd: workspacePath });
      let stdout = "";
      let stderr = "";
      const timeoutId = setTimeout(() => {
        if (!activeRun || activeRun.runId !== runId) return;
        activeRun.timedOut = true;
        appendSystemLog(sender, runId, outputStream, "[Timeout exceeded]\n");
        terminateProcess(child, false);
      }, RUN_TIMEOUT_MS);

      activeRun = {
        runId,
        workspacePath,
        command: `${command} ${args.join(" ")}`.trim(),
        startTime: new Date().toISOString(),
        runDir: "",
        outputStream,
        child,
        timeoutId,
        cancelled: false,
        timedOut: false,
        killGroup: false
      };

      const sendChunk = (source: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString();
        if (source === "stdout") {
          stdout += text;
        } else {
          stderr += text;
        }
        outputStream.write(text);
        sender.send("run:output", { runId, source, text });
      };

      child.stdout.on("data", (chunk) => sendChunk("stdout", chunk));
      child.stderr.on("data", (chunk) => sendChunk("stderr", chunk));

      child.on("close", (code) => {
        if (activeRun?.runId === runId) {
          clearTimeout(activeRun.timeoutId);
        }
        const cancelled = activeRun?.cancelled ?? false;
        const timedOut = activeRun?.timedOut ?? false;
        activeRun = null;
        resolve({ exitCode: code ?? -1, cancelled, timedOut, stdout, stderr });
      });

      child.on("error", (error) => {
        if (activeRun?.runId === runId) {
          clearTimeout(activeRun.timeoutId);
        }
        appendSystemLog(sender, runId, outputStream, `Command error: ${error.message}\n`);
        const cancelled = activeRun?.cancelled ?? false;
        const timedOut = activeRun?.timedOut ?? false;
        activeRun = null;
        resolve({ exitCode: -1, cancelled, timedOut, stdout, stderr });
      });
    }
  );

const runExecutorCommand = (
  tool: string,
  args: string[],
  workspacePath: string,
  runId: string,
  sender: WebContents,
  outputStream: fs.WriteStream
) =>
  new Promise<{ exitCode: number; cancelled: boolean; timedOut: boolean; error?: string }>((resolve) => {
    const child = spawn(tool, args, { cwd: workspacePath, detached: true });
    const timeoutId = setTimeout(() => {
      if (!activeRun || activeRun.runId !== runId) return;
      activeRun.timedOut = true;
      appendSystemLog(sender, runId, outputStream, "[Timeout exceeded]\n");
      terminateProcess(child, true);
    }, RUN_TIMEOUT_MS);

    activeRun = {
      runId,
      workspacePath,
      command: `executor:${tool} ${args.join(" ")}`.trim(),
      startTime: new Date().toISOString(),
      runDir: "",
      outputStream,
      child,
      timeoutId,
      cancelled: false,
      timedOut: false,
      killGroup: true
    };

    const sendChunk = (source: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
      const prefix = source === "stderr" ? "[executor][stderr] " : "[executor] ";
      outputStream.write(`${prefix}${text}`);
      sender.send("run:output", { runId, source, text: `${prefix}${text}` });
    };

    child.stdout.on("data", (chunk) => sendChunk("stdout", chunk));
    child.stderr.on("data", (chunk) => sendChunk("stderr", chunk));

    child.on("close", (code) => {
      if (activeRun?.runId === runId) {
        clearTimeout(activeRun.timeoutId);
      }
      const cancelled = activeRun?.cancelled ?? false;
      const timedOut = activeRun?.timedOut ?? false;
      activeRun = null;
      resolve({ exitCode: code ?? -1, cancelled, timedOut });
    });

    child.on("error", (error) => {
      if (activeRun?.runId === runId) {
        clearTimeout(activeRun.timeoutId);
      }
      const message = error.code === "ENOENT" ? `${tool} not found in PATH` : error.message;
      appendSystemLog(sender, runId, outputStream, `Executor error: ${message}\n`);
      const cancelled = activeRun?.cancelled ?? false;
      const timedOut = activeRun?.timedOut ?? false;
      activeRun = null;
      resolve({ exitCode: -1, cancelled, timedOut, error: message });
    });
  });

const runExecutorStreaming = async (
  tool: string,
  instructions: string,
  workspacePath: string,
  runId: string,
  sender: WebContents,
  outputStream: fs.WriteStream
) => {
  const execArgs = ["exec", "-C", workspacePath, "--full-auto", instructions.trim()];
  return runExecutorCommand(tool, execArgs, workspacePath, runId, sender, outputStream);
};

const runPlanInternal = async (
  sender: WebContents,
  payload: { workspacePath: string; planPath?: string }
): Promise<string> => {
  if (activePlan) {
    throw new Error("Another run is already active");
  }

  const { workspacePath } = payload;
  if (!workspacePath) {
    throw new Error("Workspace not set");
  }

  const isRepo = await isGitRepo(workspacePath);
  if (!isRepo) {
    throw new Error("Not a git repository (no .git found)");
  }

  const planPath = payload.planPath?.trim() || "plan.md";
  const resolvedPlanPath = path.isAbsolute(planPath)
    ? planPath
    : path.join(workspacePath, planPath);
  const plan = await parsePlanFile(resolvedPlanPath);

  const runId = String(Date.now());
  const startTime = new Date().toISOString();
  const runDir = await ensureRunDir(runId);
  const outputPath = path.join(runDir, "output.log");
  const outputStream = fs.createWriteStream(outputPath, { flags: "a" });
  const totalSteps = plan.steps.length;

  activePlan = {
    runId,
    workspacePath,
    runDir,
    outputStream,
    sender,
    cancelled: false
  };

  const runMeta: Record<string, unknown> = {
    run_id: runId,
    workspacePath,
    startTime,
    plan: {
      name: plan.plan_name,
      stepsCount: totalSteps,
      source: resolvedPlanPath
    },
    steps: []
  };

  let lastExitCode = 0;
  let blockedByPolicy = false;
  let timedOut = false;
  let cancelled = false;

  for (let index = 0; index < plan.steps.length; index += 1) {
    if (activePlan.cancelled) {
      cancelled = true;
      lastExitCode = -1;
      break;
    }

    const step = plan.steps[index];
    sender.send("run:step", { runId, stepIndex: index + 1, total: totalSteps });

    const stepMeta: Record<string, unknown> = {
      step_index: index + 1,
      type: step.type,
      started_at: new Date().toISOString()
    };

    if (step.type === "note") {
      appendSystemLog(sender, runId, outputStream, `Note: ${step.message}\n`);
      stepMeta.ended_at = new Date().toISOString();
      (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
      await writeRunMeta(runDir, runMeta);
      continue;
    }

    if (step.type === "executor") {
      const tool = step.tool;
      stepMeta.tool = tool;
      stepMeta.instructions_length = step.instructions.length;

      if (!isExecutorToolAllowed(tool)) {
        appendSystemLog(sender, runId, outputStream, "Executor tool not allowed by policy\n");
        stepMeta.blocked_by_policy = true;
        stepMeta.exit_code = -1;
        blockedByPolicy = true;
        lastExitCode = -1;
        const evidence = await collectGitEvidence(workspacePath, sender, runId, outputStream);
        stepMeta.evidence = evidence;
        runMeta.evidence = evidence;
        stepMeta.ended_at = new Date().toISOString();
        (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
        await writeRunMeta(runDir, runMeta);
        break;
      }

      const result = await runExecutorStreaming(
        tool,
        step.instructions,
        workspacePath,
        runId,
        sender,
        outputStream
      );
      stepMeta.exit_code = result.exitCode;
      stepMeta.cancelled = result.cancelled;
      stepMeta.timeout = result.timedOut;
      if (result.error) {
        stepMeta.error = result.error;
      }

      if (result.cancelled) {
        cancelled = true;
        lastExitCode = result.exitCode;
      } else if (result.timedOut) {
        timedOut = true;
        lastExitCode = result.exitCode;
      } else {
        lastExitCode = result.exitCode;
      }

      const evidence = await collectGitEvidence(workspacePath, sender, runId, outputStream);
      stepMeta.evidence = evidence;
      runMeta.evidence = evidence;
      stepMeta.ended_at = new Date().toISOString();
      (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
      await writeRunMeta(runDir, runMeta);

      if (result.cancelled || result.timedOut || result.exitCode !== 0) {
        break;
      }
      continue;
    }

    const command = step.command;
    stepMeta.command = command;

    if (!isCommandAllowed(command)) {
      appendSystemLog(sender, runId, outputStream, "Command not allowed by policy\n");
      stepMeta.blocked_by_policy = true;
      stepMeta.exit_code = -1;
      blockedByPolicy = true;
      lastExitCode = -1;
      const evidence = await collectGitEvidence(workspacePath, sender, runId, outputStream);
      stepMeta.evidence = evidence;
      runMeta.evidence = evidence;
      stepMeta.ended_at = new Date().toISOString();
      (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
      await writeRunMeta(runDir, runMeta);
      break;
    }

    if (hasForbiddenShellOperators(command)) {
      appendSystemLog(sender, runId, outputStream, "Command contains forbidden shell operators\n");
      stepMeta.blocked_by_policy = true;
      stepMeta.exit_code = -1;
      blockedByPolicy = true;
      lastExitCode = -1;
      const evidence = await collectGitEvidence(workspacePath, sender, runId, outputStream);
      stepMeta.evidence = evidence;
      runMeta.evidence = evidence;
      stepMeta.ended_at = new Date().toISOString();
      (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
      await writeRunMeta(runDir, runMeta);
      break;
    }

    const parts = splitArgs(command);
    const [bin, ...args] = parts;
    if (!bin) {
      appendSystemLog(sender, runId, outputStream, "Command parse failed\n");
      stepMeta.exit_code = -1;
      lastExitCode = -1;
      stepMeta.ended_at = new Date().toISOString();
      (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
      await writeRunMeta(runDir, runMeta);
      break;
    }

    const result = await runCommandStreaming(bin, args, workspacePath, runId, sender, outputStream);
    const stdout = result.stdout.trim();
    const isGrep = command.startsWith("git grep");
    const isGrepNoMatch = isGrep && result.exitCode === 1;
    const effectiveExitCode = isGrepNoMatch ? 0 : result.exitCode;
    if (isGrepNoMatch) {
      appendSystemLog(sender, runId, outputStream, "[precheck] no matches\n");
    }

    stepMeta.exit_code = result.exitCode;
    stepMeta.cancelled = result.cancelled;
    stepMeta.timeout = result.timedOut;
    stepMeta.stdout = stdout;

    if (result.cancelled) {
      cancelled = true;
      lastExitCode = effectiveExitCode;
    } else if (result.timedOut) {
      timedOut = true;
      lastExitCode = effectiveExitCode;
    } else {
      lastExitCode = effectiveExitCode;
    }

    const evidence = await collectGitEvidence(workspacePath, sender, runId, outputStream);
    stepMeta.evidence = evidence;
    runMeta.evidence = evidence;
    stepMeta.ended_at = new Date().toISOString();
    (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
    await writeRunMeta(runDir, runMeta);

    if (result.cancelled || result.timedOut || effectiveExitCode !== 0) {
      break;
    }
  }

  const endTime = new Date().toISOString();
  runMeta.endTime = endTime;
  runMeta.exitCode = lastExitCode;
  if (blockedByPolicy) runMeta.blocked_by_policy = true;
  if (timedOut) runMeta.timeout = true;
  if (cancelled) runMeta.cancelled = true;

  await writeRunMeta(runDir, runMeta);
  outputStream.end();
  sender.send("run:done", { runId, exitCode: lastExitCode });

  activePlan = null;
  return runId;
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

  ipcMain.handle(
    "run:plan",
    async (event, payload: { workspacePath: string; planPath?: string }) => {
      try {
        const result = await runPlanInternal(event.sender, payload);
        return { ok: true, result };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return {
          ok: false,
          error: {
            code: "UNKNOWN",
            name: error instanceof Error ? error.name : "Error",
            message
          }
        };
      }
    }
  );

  ipcMain.handle("run:cancel", async (event, runId: string) => {
    if (!activePlan || activePlan.runId !== runId) {
      return false;
    }
    activePlan.cancelled = true;
    appendSystemLog(event.sender, runId, activePlan.outputStream, "[Cancelled by user]\n");
    if (activeRun && activeRun.runId === runId) {
      activeRun.cancelled = true;
      terminateProcess(activeRun.child, activeRun.killGroup);
    }
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
