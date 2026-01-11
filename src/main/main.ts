import { app, BrowserWindow, dialog, ipcMain, type WebContents } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ZodError } from "zod";
import { TaskPlanSchema, type TaskPlan } from "../shared/protocol";

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
const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODEL = "gpt-4o-mini";
const DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml"
]);

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

const PLAN_SYSTEM_PROMPT = [
  "You are a software development task planner.",
  "Output must be strict JSON and must not include markdown or extra text.",
  "Schema:",
  '{ "plan_name": string, "steps": [ { "type": "note", "message": string } | { "type": "cmd", "command": string } ] }',
  "Constraints:",
  '- step.type must be only "note" or "cmd".',
  `- cmd.command must start with one of: ${ALLOWED_COMMAND_PREFIXES.join(", ") || "none"}.`,
  "- no more than 8 steps.",
  "- include at least 1 note step.",
  '- the last step should be "git status -sb" or "git diff --stat" when possible.',
  "Return JSON only."
].join("\n");

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

type ActivePlan = {
  runId: string;
  workspacePath: string;
  runDir: string;
  outputStream: fs.WriteStream;
  sender: WebContents;
  cancelled: boolean;
};

type DecisionWaiter = {
  runDir: string;
  files: string[];
  resolve: (result: "approved" | "rejected") => void;
};

let activeRun: ActiveRun | null = null;
let activePlan: ActivePlan | null = null;
const pendingDecisions = new Map<string, DecisionWaiter>();

const writeRunMeta = async (runDir: string, meta: Record<string, unknown>) => {
  await fs.promises.writeFile(
    path.join(runDir, "run.json"),
    JSON.stringify(meta, null, 2),
    "utf-8"
  );
};

const mergeDecisionFromDisk = async (runDir: string, meta: Record<string, unknown>) => {
  try {
    const existing = JSON.parse(await fs.promises.readFile(path.join(runDir, "run.json"), "utf-8"));
    if (existing.decision) {
      meta.decision = existing.decision;
    }
  } catch {
    // Ignore missing/invalid run.json while plan is still running.
  }
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

const parseNameOnly = (value: string) =>
  value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

const matchDependencyFiles = (files: string[]) => {
  const matched = new Set<string>();
  for (const file of files) {
    for (const depFile of DEPENDENCY_FILES) {
      if (file === depFile || file.endsWith(`/${depFile}`)) {
        matched.add(file);
      }
    }
  }
  return Array.from(matched);
};

const formatZodError = (error: ZodError) =>
  error.issues
    .map((issue) => {
      const path = issue.path.length ? issue.path.join(".") : "plan";
      return `${path}: ${issue.message}`;
    })
    .join("; ");

const validateGeneratedPlan = (plan: TaskPlan) => {
  const issues: string[] = [];

  if (plan.steps.length > 8) {
    issues.push("plan must have at most 8 steps");
  }

  if (!plan.steps.some((step) => step.type === "note")) {
    issues.push("plan must include at least 1 note step");
  }

  for (const step of plan.steps) {
    if (step.type !== "cmd") continue;
    const command = step.command.trim();
    if (!command) {
      issues.push("cmd.command cannot be empty");
      continue;
    }
    if (!isCommandAllowed(command)) {
      issues.push(`cmd.command not allowed: ${command}`);
    }
  }

  if (issues.length > 0) {
    throw new Error(issues.join("; "));
  }
};

const generatePlanFromRequirement = async (requirement: string): Promise<TaskPlan> => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY is not set");
  }

  const response = await fetch(OPENAI_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: OPENAI_MODEL,
      temperature: 0.2,
      messages: [
        { role: "system", content: PLAN_SYSTEM_PROMPT },
        { role: "user", content: requirement.trim() }
      ]
    })
  });

  if (!response.ok) {
    let message = `OpenAI API error (${response.status})`;
    try {
      const data = await response.json();
      if (data?.error?.message) {
        message = data.error.message;
      }
    } catch {
      // keep fallback message
    }
    throw new Error(message);
  }

  const data = (await response.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const content = data?.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("OpenAI response missing content");
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid JSON from planner: ${message}`);
  }

  try {
    const plan = TaskPlanSchema.parse(parsedJson);
    validateGeneratedPlan(plan);
    return plan;
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Error(`Plan schema validation failed: ${formatZodError(error)}`);
    }
    throw error;
  }
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

const maybeRequestDecision = async (
  evidence: Record<string, string> | { error: string },
  runId: string,
  runDir: string,
  sender: WebContents,
  outputStream: fs.WriteStream
): Promise<"approved" | "rejected" | null> => {
  if ("error" in evidence) return null;
  const nameOnly = evidence.git_diff_name_only;
  if (!nameOnly) return null;

  const changedFiles = parseNameOnly(nameOnly);
  const dependencyFiles = matchDependencyFiles(changedFiles);
  if (dependencyFiles.length === 0) return null;

  appendSystemLog(
    sender,
    runId,
    outputStream,
    `Dependency changes detected. Awaiting approval: ${dependencyFiles.join(", ")}\n`
  );
  sender.send("run:decision", { runId, files: dependencyFiles });

  return new Promise((resolve) => {
    pendingDecisions.set(runId, { runDir, files: dependencyFiles, resolve });
  });
};

const runCommandStreaming = (
  command: string,
  args: string[],
  workspacePath: string,
  runId: string,
  sender: WebContents,
  outputStream: fs.WriteStream
) =>
  new Promise<{ exitCode: number; cancelled: boolean; timedOut: boolean }>((resolve) => {
    const child = spawn(command, args, { cwd: workspacePath });
    const timeoutId = setTimeout(() => {
      if (!activeRun || activeRun.runId !== runId) return;
      activeRun.timedOut = true;
      appendSystemLog(sender, runId, outputStream, "[Timeout exceeded]\n");
      terminateProcess(child);
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
      timedOut: false
    };

    const sendChunk = (source: "stdout" | "stderr", chunk: Buffer) => {
      const text = chunk.toString();
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
      resolve({ exitCode: code ?? -1, cancelled, timedOut });
    });

    child.on("error", (error) => {
      if (activeRun?.runId === runId) {
        clearTimeout(activeRun.timeoutId);
      }
      appendSystemLog(sender, runId, outputStream, `Command error: ${error.message}\n`);
      const cancelled = activeRun?.cancelled ?? false;
      const timedOut = activeRun?.timedOut ?? false;
      activeRun = null;
      resolve({ exitCode: -1, cancelled, timedOut });
    });
  });

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

  ipcMain.handle("planner:generatePlan", async (_event, requirement: string) => {
    if (!requirement || !requirement.trim()) {
      throw new Error("Requirement is empty");
    }
    return generatePlanFromRequirement(requirement);
  });

  ipcMain.handle(
    "run:plan",
    async (event, payload: { workspacePath: string; plan: TaskPlan; requirement?: string }) => {
    if (activePlan) {
      throw new Error("Another run is already active");
    }

    const { workspacePath, plan, requirement } = payload;
    if (!workspacePath) {
      throw new Error("Workspace not set");
    }
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      throw new Error("Plan is empty");
    }

    const isRepo = await isGitRepo(workspacePath);
    if (!isRepo) {
      throw new Error("Not a git repository (no .git found)");
    }

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
      sender: event.sender,
      cancelled: false
    };

    const runMeta: Record<string, unknown> = {
      run_id: runId,
      workspacePath,
      startTime,
      requirement: requirement ? requirement.trim() : "",
      plan: {
        name: plan.plan_name,
        stepsCount: totalSteps
      },
      steps: []
    };

    let lastExitCode = 0;
    let blockedByPolicy = false;
    let timedOut = false;
    let cancelled = false;
    let cancelledByDecision = false;

    for (let index = 0; index < plan.steps.length; index += 1) {
      if (activePlan.cancelled) {
        cancelled = true;
        lastExitCode = -1;
        break;
      }

      const step = plan.steps[index];
      event.sender.send("run:step", { runId, stepIndex: index + 1, total: totalSteps });

      const stepMeta: Record<string, unknown> = {
        step_index: index + 1,
        type: step.type,
        started_at: new Date().toISOString()
      };

      if (step.type === "note") {
        appendSystemLog(event.sender, runId, outputStream, `Note: ${step.message}\n`);
        stepMeta.ended_at = new Date().toISOString();
        (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
        await writeRunMeta(runDir, runMeta);
        continue;
      }

      const command = step.command;
      stepMeta.command = command;

      if (!isCommandAllowed(command)) {
        appendSystemLog(event.sender, runId, outputStream, "Command not allowed by policy\n");
        stepMeta.blocked_by_policy = true;
        stepMeta.exit_code = -1;
        blockedByPolicy = true;
        lastExitCode = -1;
        const evidence = await collectGitEvidence(workspacePath, event.sender, runId, outputStream);
        stepMeta.evidence = evidence;
        runMeta.evidence = evidence;
        stepMeta.ended_at = new Date().toISOString();
        (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
        await writeRunMeta(runDir, runMeta);
        const decisionResult = await maybeRequestDecision(evidence, runId, runDir, event.sender, outputStream);
        if (decisionResult) {
          await mergeDecisionFromDisk(runDir, runMeta);
        }
        break;
      }

      const parts = command.split(" ").filter(Boolean);
      const [bin, ...args] = parts;
      const result = await runCommandStreaming(bin, args, workspacePath, runId, event.sender, outputStream);
      stepMeta.exit_code = result.exitCode;
      stepMeta.cancelled = result.cancelled;
      stepMeta.timeout = result.timedOut;

      if (result.cancelled) {
        cancelled = true;
        lastExitCode = result.exitCode;
      } else if (result.timedOut) {
        timedOut = true;
        lastExitCode = result.exitCode;
      } else {
        lastExitCode = result.exitCode;
      }

      const evidence = await collectGitEvidence(workspacePath, event.sender, runId, outputStream);
      stepMeta.evidence = evidence;
      runMeta.evidence = evidence;
      stepMeta.ended_at = new Date().toISOString();
      (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
      await writeRunMeta(runDir, runMeta);

      if (result.cancelled || result.timedOut || result.exitCode !== 0) {
        break;
      }

      const decisionResult = await maybeRequestDecision(evidence, runId, runDir, event.sender, outputStream);
      if (decisionResult) {
        await mergeDecisionFromDisk(runDir, runMeta);
        if (decisionResult === "rejected") {
          cancelledByDecision = true;
          break;
        }
        if (activePlan.cancelled) {
          cancelled = true;
          lastExitCode = -1;
          break;
        }
      }
    }

    const endTime = new Date().toISOString();
    await mergeDecisionFromDisk(runDir, runMeta);
    runMeta.endTime = endTime;
    runMeta.exitCode = lastExitCode;
    if (blockedByPolicy) runMeta.blocked_by_policy = true;
    if (timedOut) runMeta.timeout = true;
    if (cancelled) runMeta.cancelled = true;
    if (cancelledByDecision) runMeta.cancelled_by_decision = true;

    await writeRunMeta(runDir, runMeta);
    outputStream.end();
    event.sender.send("run:done", { runId, exitCode: lastExitCode });

    activePlan = null;
    return runId;
  });

  ipcMain.handle("run:cancel", async (event, runId: string) => {
    if (!activePlan || activePlan.runId !== runId) {
      return false;
    }
    activePlan.cancelled = true;
    appendSystemLog(event.sender, runId, activePlan.outputStream, "[Cancelled by user]\n");
    if (activeRun && activeRun.runId === runId) {
      activeRun.cancelled = true;
      terminateProcess(activeRun.child);
    }
    const pending = pendingDecisions.get(runId);
    if (pending) {
      pending.resolve("rejected");
      pendingDecisions.delete(runId);
    }
    event.sender.send("run:cancelled", { runId });
    return true;
  });

  ipcMain.handle(
    "run:decision",
    async (_event, payload: { runId: string; result: "approved" | "rejected" }) => {
      const pending = pendingDecisions.get(payload.runId);
      if (!pending) return false;
      const runPath = path.join(pending.runDir, "run.json");
      const existing = JSON.parse(await fs.promises.readFile(runPath, "utf-8"));
      const decision = {
        type: "dependency_change",
        result: payload.result,
        timestamp: new Date().toISOString(),
        files: pending.files
      };
      await writeRunMeta(pending.runDir, { ...existing, decision });
      pending.resolve(payload.result);
      pendingDecisions.delete(payload.runId);
      return true;
    }
  );
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
