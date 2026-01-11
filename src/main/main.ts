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
const ALLOWED_EXECUTOR_TOOLS = new Set(["codex"]);
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

const isExecutorToolAllowed = (tool: string) => ALLOWED_EXECUTOR_TOOLS.has(tool);

const PROMPT_RELATIVE_PATH = path.join("shared", "planner", "planner_system_prompt_v1.txt");
const DIST_RELATIVE_PATH = path.join("dist", PROMPT_RELATIVE_PATH);
const SRC_RELATIVE_PATH = path.join("src", PROMPT_RELATIVE_PATH);

const loadPlannerSystemPrompt = async () => {
  const basePaths = app.isPackaged ? [process.resourcesPath, __dirname] : [process.cwd()];
  const attemptedPaths: string[] = [];

  for (const base of basePaths) {
    const distPath = path.join(base, DIST_RELATIVE_PATH);
    attemptedPaths.push(distPath);
    try {
      const prompt = await fs.promises.readFile(distPath, "utf-8");
      console.log(`[planner] system prompt loaded from: ${distPath}`);
      console.log(`[planner] system prompt length: ${prompt.length}`);
      return prompt;
    } catch {
      // try fallback
    }

    const srcPath = path.join(base, SRC_RELATIVE_PATH);
    attemptedPaths.push(srcPath);
    try {
      const prompt = await fs.promises.readFile(srcPath, "utf-8");
      console.log(`[planner] system prompt loaded from: ${srcPath}`);
      console.log(`[planner] system prompt length: ${prompt.length}`);
      return prompt;
    } catch {
      // try next base
    }
  }

  throw new Error(
    `Planner system prompt not found. Tried: ${attemptedPaths.join(", ")}`
  );
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

const previewText = (value: string, limit = 200) => value.slice(0, limit);

const extractJsonFromText = (rawText: string) => {
  const trimmed = rawText.trim();
  if (!trimmed) {
    throw new Error("Planner output is empty");
  }

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  const firstBrace = trimmed.indexOf("{");
  const lastBrace = trimmed.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("Planner output does not contain a JSON object");
  }

  return trimmed.slice(firstBrace, lastBrace + 1);
};

const normalizePlannerContent = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (typeof item === "string") return item;
        if (item && typeof item === "object" && "text" in item && typeof item.text === "string") {
          return item.text;
        }
        return "";
      })
      .join("");
  }
  return "";
};

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

  const systemPrompt = await loadPlannerSystemPrompt();
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
        { role: "system", content: systemPrompt },
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
    choices?: Array<{ message?: { content?: unknown } }>;
  };
  const rawText = normalizePlannerContent(data?.choices?.[0]?.message?.content);
  if (!rawText) {
    throw new Error("OpenAI response missing content");
  }

  const rawPreview = previewText(rawText);
  console.log(`[planner] raw output length: ${rawText.length}`);
  console.log(`[planner] raw output preview: ${rawPreview}`);

  let parsedJson: unknown;
  let extractedJsonText = "";
  try {
    extractedJsonText = extractJsonFromText(rawText);
    parsedJson = JSON.parse(extractedJsonText);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Planner JSON parse error: ${message}; rawPreview="${rawPreview}"`
    );
  }

  try {
    const plan = TaskPlanSchema.parse(parsedJson);
    validateGeneratedPlan(plan);
    return plan;
  } catch (error) {
    const extractedPreview = previewText(extractedJsonText);
    const parsedPreview = previewText(
      JSON.stringify(parsedJson ?? null)
    );
    if (error instanceof ZodError) {
      throw new Error(
        `Plan schema validation failed: ${formatZodError(error)}; rawPreview="${rawPreview}"; extractedPreview="${extractedPreview}"; parsedPreview="${parsedPreview}"`
      );
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
  const execResult = await runExecutorCommand(
    tool,
    execArgs,
    workspacePath,
    runId,
    sender,
    outputStream
  );
  if (execResult.exitCode !== 0 || execResult.cancelled || execResult.timedOut || execResult.error) {
    return execResult;
  }

  const applyArgs = ["apply", "-C", workspacePath];
  const applyResult = await runExecutorCommand(
    tool,
    applyArgs,
    workspacePath,
    runId,
    sender,
    outputStream
  );
  return applyResult;
};

const buildRetryInstructions = () =>
  [
    "ONLY edit src/renderer/App.tsx.",
    "Ensure that after applying changes, `git diff --name-only` is non-empty and includes src/renderer/App.tsx.",
    "If the feature already exists, do not duplicate UI; make a minimal fix to behavior or wiring so a real diff is produced.",
    "Do not add dependencies; do not modify package.json/lockfiles; do not run npm install."
  ].join(" ");

const diffFromBaseline = (baseline: string[], current: string[]) => {
  const baselineSet = new Set(baseline);
  return current.filter((file) => !baselineSet.has(file));
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
    let lastPrecheckHit = false;

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
        lastPrecheckHit = false;
        continue;
      }

      if (step.type === "executor") {
        const tool = step.tool;
        stepMeta.tool = tool;
        stepMeta.instructions_length = step.instructions.length;

        if (!isExecutorToolAllowed(tool)) {
          appendSystemLog(event.sender, runId, outputStream, "Executor tool not allowed by policy\n");
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

        const baselineResult = await runCommandCapture(
          "git",
          ["diff", "--name-only"],
          workspacePath
        );
        const baselineFiles =
          baselineResult.code === 0 && baselineResult.stdout
            ? parseNameOnly(baselineResult.stdout)
            : [];

        let result = await runExecutorStreaming(
          tool,
          step.instructions,
          workspacePath,
          runId,
          event.sender,
          outputStream
        );
        stepMeta.exit_code = result.exitCode;
        stepMeta.cancelled = result.cancelled;
        stepMeta.timeout = result.timedOut;
        if (result.error) {
          stepMeta.error = result.error;
        }

        const evidence = await collectGitEvidence(workspacePath, event.sender, runId, outputStream);
        let currentFiles: string[] = [];
        if (!("error" in evidence) && typeof evidence.git_diff_name_only === "string") {
          currentFiles = parseNameOnly(evidence.git_diff_name_only);
        }
        const changedFiles = diffFromBaseline(baselineFiles, currentFiles);
        const hasChanges = changedFiles.length > 0;
        const evaluation: Record<string, unknown> = {
          baseline_files: baselineFiles,
          current_files: currentFiles,
          changed_files: changedFiles,
          has_changes: hasChanges,
          retried: false
        };
        if (result.exitCode === 0 && !hasChanges) {
          evaluation.suspicious_no_change = true;
        }
        if (result.exitCode === 0 && lastPrecheckHit && !hasChanges) {
          evaluation.no_op = true;
        }
        if (evaluation.no_op) {
          appendSystemLog(
            event.sender,
            runId,
            outputStream,
            "[auto] no-op detected from precheck; skipping modification retry\n"
          );
          const grepResult = await runCommandCapture(
            "git",
            ["grep", "-n", "Clear Logs", "--", "src/renderer/App.tsx"],
            workspacePath
          );
          if (grepResult.stdout) {
            appendSystemLog(event.sender, runId, outputStream, grepResult.stdout);
          }
          if (grepResult.stderr) {
            appendSystemLog(event.sender, runId, outputStream, grepResult.stderr);
          }
        } else if (evaluation.suspicious_no_change) {
          evaluation.retried = true;
          const retryInstructions = buildRetryInstructions();
          const retryResult = await runExecutorStreaming(
            tool,
            retryInstructions,
            workspacePath,
            runId,
            event.sender,
            outputStream
          );
          let retryChanged: string[] = [];
          const retryDiff = await runCommandCapture(
            "git",
            ["diff", "--name-only"],
            workspacePath
          );
          let retryCurrent: string[] = [];
          if (retryDiff.code === 0 && retryDiff.stdout) {
            retryCurrent = parseNameOnly(retryDiff.stdout);
          }
          retryChanged = diffFromBaseline(baselineFiles, retryCurrent);
          const retryHasChanges = retryChanged.length > 0;
          evaluation.retry_result = {
            exit_code: retryResult.exitCode,
            baseline_files: baselineFiles,
            current_files: retryCurrent,
            changed_files: retryChanged,
            has_changes: retryHasChanges
          };
          if (!retryHasChanges) {
            appendSystemLog(
              event.sender,
              runId,
              outputStream,
              "[auto] retry produced no changes; user attention may be required\n"
            );
          }

          result = retryResult;
          stepMeta.exit_code = retryResult.exitCode;
          stepMeta.cancelled = retryResult.cancelled;
          stepMeta.timeout = retryResult.timedOut;
          if (retryResult.error) {
            stepMeta.error = retryResult.error;
          }
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
        stepMeta.evaluation = evaluation;
        appendSystemLog(
          event.sender,
          runId,
          outputStream,
          `[evaluation] changed_files=${changedFiles.join(", ") || "(none)"} suspicious_no_change=${Boolean(
            evaluation.suspicious_no_change
          )} no_op=${Boolean(evaluation.no_op)}\n`
        );
        const finalEvidence =
          evaluation.retried === true
            ? await collectGitEvidence(workspacePath, event.sender, runId, outputStream)
            : evidence;
        stepMeta.evidence = finalEvidence;
        runMeta.evidence = finalEvidence;
        stepMeta.ended_at = new Date().toISOString();
        (runMeta.steps as Record<string, unknown>[]).push(stepMeta);
        await writeRunMeta(runDir, runMeta);
        lastPrecheckHit = false;

        if (result.cancelled || result.timedOut || result.exitCode !== 0) {
          break;
        }

        const decisionResult = await maybeRequestDecision(finalEvidence, runId, runDir, event.sender, outputStream);
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
      const stdout = result.stdout.trim();
      const isPrecheck =
        command.startsWith("git grep") && command.includes("Clear Logs") && command.includes("src/renderer/App.tsx");
      lastPrecheckHit = isPrecheck && Boolean(stdout);
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
      terminateProcess(activeRun.child, activeRun.killGroup);
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
