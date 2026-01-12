import React, { useEffect, useMemo, useRef, useState } from "react";
import { TaskPlanSchema, type TaskPlan } from "../shared/protocol";

type LogEntry = {
  id: string;
  text: string;
  source: "stdout" | "stderr" | "system";
};

type DecisionState = {
  runId: string;
  files: string[];
};

type AutobuildRound = {
  iteration: number;
  planName?: string;
  planJson?: string;
  runId?: string;
  statuses: Array<{ phase: "planning" | "running" | "done"; message: string }>;
  outcome?: string;
  evaluationBrief?: string;
};

const defaultPlan: TaskPlan = {
  plan_name: "Default plan",
  steps: [
    { type: "note", message: "Starting plan." },
    { type: "cmd", command: "git status -sb" }
  ]
};

const App = () => {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [runsRoot, setRunsRoot] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    { id: "boot", text: "Ready.\n", source: "system" }
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [decision, setDecision] = useState<DecisionState | null>(null);
  const [stepProgress, setStepProgress] = useState<{ current: number; total: number } | null>(null);
  const [planInput, setPlanInput] = useState(() => JSON.stringify(defaultPlan, null, 2));
  const [planError, setPlanError] = useState<string | null>(null);
  const [generateError, setGenerateError] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isAutobuilding, setIsAutobuilding] = useState(false);
  const [autobuildStatus, setAutobuildStatus] = useState<{
    iteration: number;
    phase: "planning" | "running" | "done";
    message: string;
  } | null>(null);
  const [autobuildRuns, setAutobuildRuns] = useState<AutobuildRound[]>([]);
  const [autobuildStopReason, setAutobuildStopReason] = useState<string | null>(null);
  const [dirtyGuardMessage, setDirtyGuardMessage] = useState<string | null>(null);
  const [verifyOnlyRequested, setVerifyOnlyRequested] = useState<boolean>(false);
  const [apiError, setApiError] = useState<string | null>(null);
  const [requirement, setRequirement] = useState("");
  const [showClearLogs, setShowClearLogs] = useState(true);
  const logRef = useRef<HTMLPreElement | null>(null);

  const appendLog = (entry: LogEntry) => {
    setLogEntries((prev) => [...prev, entry]);
  };

  const clearLogs = () => {
    setLogEntries([]);
  };

  const selectWorkspace = async () => {
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }
    const selected = await window.api.selectWorkspace();
    if (selected) {
      setWorkspacePath(selected);
      setVerifyOnlyRequested(false);
      appendLog({
        id: `${Date.now()}-workspace`,
        text: `Workspace set: ${selected}\n`,
        source: "system"
      });
    }
  };

  const formatZodIssues = (issues: { path: Array<string | number>; message: string }[]) =>
    issues
      .map((issue) => {
        const path = issue.path.length ? issue.path.join(".") : "plan";
        return `${path}: ${issue.message}`;
      })
      .join("; ");

  const parsePlan = (value: string): TaskPlan => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Invalid JSON: ${message}`);
    }
    const result = TaskPlanSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(formatZodIssues(result.error.issues));
    }
    return result.data;
  };

  const runPlan = async (allowDirtyVerifyOnly = false) => {
    const verifyOnly = allowDirtyVerifyOnly === true;
    const verifyOnlyFlag = verifyOnlyRequested === true;
    const logSnapshot = (planValid: boolean, hasExecutor: boolean) =>
      `[ui] runPlan click workspaceSet=${Boolean(workspacePath)} planJsonValid=${planValid} hasExecutor=${hasExecutor} verifyOnlyRequested=${verifyOnlyFlag} isRunning=${isRunning} isAutobuilding=${isAutobuilding}\n`;

    if (isRunning) {
      appendLog({
        id: `${Date.now()}-run-blocked`,
        text: "[ui] runPlan blocked: already running\n",
        source: "system"
      });
      console.debug("[ui] runPlan blocked: already running");
      return;
    }
    if (isAutobuilding) {
      appendLog({
        id: `${Date.now()}-run-blocked`,
        text: "[ui] runPlan blocked: autobuild active\n",
        source: "system"
      });
      console.debug("[ui] runPlan blocked: autobuild active");
      return;
    }
    if (!workspacePath) {
      appendLog({
        id: `${Date.now()}-error`,
        text: "Workspace not set.\n",
        source: "system"
      });
      appendLog({
        id: `${Date.now()}-run-blocked`,
        text: "[ui] runPlan blocked: workspace not set\n",
        source: "system"
      });
      console.debug("[ui] runPlan blocked: workspace not set");
      return;
    }

    if (decision) {
      appendLog({
        id: `${Date.now()}-decision-pending`,
        text: "Decision required before running again.\n",
        source: "system"
      });
      appendLog({
        id: `${Date.now()}-run-blocked`,
        text: "[ui] runPlan blocked: decision pending\n",
        source: "system"
      });
      console.debug("[ui] runPlan blocked: decision pending");
      return;
    }

    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }

    let plan: TaskPlan;
    let hasExecutor = false;
    try {
      plan = parsePlan(planInput);
      setPlanError(null);
      hasExecutor = plan.steps.some((step) => step.type === "executor");
      appendLog({
        id: `${Date.now()}-run-click`,
        text: logSnapshot(true, hasExecutor),
        source: "system"
      });
      console.debug(
        logSnapshot(true, hasExecutor).trim()
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlanError(message);
      appendLog({
        id: `${Date.now()}-run-click`,
        text: logSnapshot(false, false),
        source: "system"
      });
      appendLog({
        id: `${Date.now()}-run-blocked`,
        text: `[ui] runPlan blocked: plan JSON invalid: ${message}\n`,
        source: "system"
      });
      console.debug(`[ui] runPlan blocked: plan JSON invalid: ${message}`);
      return;
    }

    if (verifyOnly && plan.steps.some((step) => step.type === "executor")) {
      setDirtyGuardMessage("Verify-only mode does not allow executor steps.");
      appendLog({
        id: `${Date.now()}-run-blocked`,
        text: "[ui] runPlan blocked: verify-only with executor\n",
        source: "system"
      });
      console.debug("[ui] runPlan blocked: verify-only with executor");
      return;
    }

    setIsRunning(true);
    setDirtyGuardMessage(null);
    appendLog({
      id: `${Date.now()}-run`,
      text: `Running plan: ${plan.plan_name}\n`,
      source: "system"
    });

    try {
      const response = await window.api.runPlan({
        workspacePath,
        plan,
        requirement,
        allowDirtyVerifyOnly: verifyOnly
      });
      if (response.ok) {
        setCurrentRunId(response.result);
        return;
      }
      if (response.error.code === "WORKSPACE_DIRTY") {
        setDirtyGuardMessage(
          "Workspace has uncommitted changes. Commit or stash them, or continue with verify-only."
        );
        return;
      }
      appendLog({
        id: `${Date.now()}-run-error`,
        text: `${response.error.message}\n`,
        source: "system"
      });
      setIsRunning(false);
      setCurrentRunId(null);
      setStepProgress(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog({
        id: `${Date.now()}-run-error`,
        text: `${message}\n`,
        source: "system"
      });
      setIsRunning(false);
      setCurrentRunId(null);
      setStepProgress(null);
    }
  };

  const resetPlan = () => {
    setPlanInput(JSON.stringify(defaultPlan, null, 2));
    setPlanError(null);
    setGenerateError(null);
  };

  const upsertAutobuildRound = (iteration: number, update: Partial<AutobuildRound>) => {
    setAutobuildRuns((prev) => {
      const existing = prev.find((round) => round.iteration === iteration);
      if (!existing) {
        return [
          ...prev,
          {
            iteration,
            statuses: update.statuses ?? [],
            ...update
          } as AutobuildRound
        ].sort((a, b) => a.iteration - b.iteration);
      }
      return prev.map((round) =>
        round.iteration === iteration ? { ...round, ...update } : round
      );
    });
  };

  const generatePlan = async () => {
    if (!requirement.trim()) {
      setGenerateError("Requirement is empty");
      return;
    }
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }

    setIsGenerating(true);
    setGenerateError(null);
    try {
      const plan = await window.api.generatePlan(requirement);
      setPlanInput(JSON.stringify(plan, null, 2));
      setPlanError(null);
      setVerifyOnlyRequested(false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setGenerateError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  const startAutobuild = async () => {
    if (!workspacePath) {
      appendLog({
        id: `${Date.now()}-autobuild-workspace`,
        text: "Workspace not set.\n",
        source: "system"
      });
      return;
    }
    if (!requirement.trim()) {
      appendLog({
        id: `${Date.now()}-autobuild-requirement`,
        text: "Requirement is empty.\n",
        source: "system"
      });
      return;
    }
    if (decision) {
      appendLog({
        id: `${Date.now()}-autobuild-decision`,
        text: "Decision required before running autobuild.\n",
        source: "system"
      });
      return;
    }
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }

    setIsAutobuilding(true);
    setAutobuildStatus(null);
    setAutobuildRuns([]);
    setAutobuildStopReason(null);
    setVerifyOnlyRequested(false);
    try {
      await window.api.startAutobuild({
        workspace: workspacePath,
        requirement,
        maxIterations: 2
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog({
        id: `${Date.now()}-autobuild-error`,
        text: `Autobuild failed: ${message}\n`,
        source: "system"
      });
      setIsAutobuilding(false);
    }
  };

  const copyRunId = async (runId: string) => {
    try {
      await navigator.clipboard.writeText(runId);
      appendLog({
        id: `${Date.now()}-copy-runid`,
        text: `Copied run_id: ${runId}\n`,
        source: "system"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog({
        id: `${Date.now()}-copy-runid-failed`,
        text: `Copy failed: ${message}\n`,
        source: "stderr"
      });
    }
  };

  const cancelRun = async () => {
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }
    if (isAutobuilding) {
      await window.api.cancelAutobuild();
    }
    if (currentRunId) {
      const cancelled = await window.api.cancelRun(currentRunId);
      if (!cancelled) {
        appendLog({
          id: `${Date.now()}-cancel-failed`,
          text: "Cancel failed (no active run).\n",
          source: "system"
        });
      }
    }
  };

  const resolveDecision = async (result: "approved" | "rejected") => {
    if (!decision) return;
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }
    const success = await window.api.submitDecision({ runId: decision.runId, result });
    if (success) {
      appendLog({
        id: `${Date.now()}-decision-result`,
        text: result === "approved" ? "[Approved by user]\n" : "[Rejected by user]\n",
        source: result === "approved" ? "system" : "stderr"
      });
      setDecision(null);
    } else {
      appendLog({
        id: `${Date.now()}-decision-fail`,
        text: "Failed to record decision.\n",
        source: "stderr"
      });
    }
  };

  useEffect(() => {
    const storedPlan = window.localStorage.getItem("planEditor");
    if (storedPlan) {
      setPlanInput(storedPlan);
    }

    const storedRequirement = window.localStorage.getItem("requirementInput");
    if (storedRequirement) {
      setRequirement(storedRequirement);
    }

    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }

    let isMounted = true;
    window.api.getRunsRoot().then((root) => {
      if (isMounted) setRunsRoot(root);
    });

    const unsubscribeOutput = window.api.onRunOutput((payload) => {
      appendLog({
        id: `${Date.now()}-${Math.random()}`,
        text: payload.text,
        source: payload.source
      });
    });

    const unsubscribeDone = window.api.onRunDone((payload) => {
      appendLog({
        id: `${Date.now()}-done`,
        text: `Process finished (exit ${payload.exitCode}).\n`,
        source: payload.exitCode === 0 ? "system" : "stderr"
      });
      setIsRunning(false);
      setCurrentRunId(null);
      setStepProgress(null);
    });

    const unsubscribeCancelled = window.api.onRunCancelled((payload) => {
      appendLog({
        id: `${Date.now()}-cancelled`,
        text: `Run ${payload.runId} cancelled.\n`,
        source: "system"
      });
      setIsRunning(false);
      setCurrentRunId(null);
      setStepProgress(null);
    });

    const unsubscribeStep = window.api.onRunStep((payload) => {
      setStepProgress({ current: payload.stepIndex, total: payload.total });
    });

    const unsubscribeDecision = window.api.onDecisionRequired((payload) => {
      setDecision({ runId: payload.runId, files: payload.files });
      appendLog({
        id: `${Date.now()}-decision`,
        text: `Dependency changes detected. Approval required.\n`,
        source: "system"
      });
    });

    const unsubscribeAutobuildStatus = window.api.onAutobuildStatus((payload) => {
      setAutobuildStatus(payload);
      setAutobuildRuns((prev) => {
        const existing = prev.find((round) => round.iteration === payload.iteration);
        const nextStatus = { phase: payload.phase, message: payload.message };
        if (!existing) {
          return [
            ...prev,
            {
              iteration: payload.iteration,
              runId: payload.run_id,
              statuses: [nextStatus]
            }
          ].sort((a, b) => a.iteration - b.iteration);
        }
        return prev.map((round) =>
          round.iteration === payload.iteration
            ? {
                ...round,
                runId: payload.run_id ?? round.runId,
                statuses: [...round.statuses, nextStatus]
              }
            : round
        );
      });
      appendLog({
        id: `${Date.now()}-autobuild-status`,
        text: `[autobuild] iter ${payload.iteration} ${payload.phase}: ${payload.message}\n`,
        source: "system"
      });
    });

    const unsubscribeAutobuildPlan = window.api.onAutobuildPlan((payload) => {
      setPlanInput(JSON.stringify(payload.plan, null, 2));
      upsertAutobuildRound(payload.iteration, {
        planName: payload.plan_name,
        planJson: JSON.stringify(payload.plan, null, 2)
      });
      appendLog({
        id: `${Date.now()}-autobuild-plan`,
        text: `[autobuild] received plan for iteration ${payload.iteration}\n`,
        source: "system"
      });
    });

    const unsubscribeAutobuildDone = window.api.onAutobuildDone((payload) => {
      setAutobuildStatus((prev) =>
        prev ? { ...prev, phase: "done", message: `Stopped: ${payload.stop_reason}` } : prev
      );
      setAutobuildStopReason(payload.stop_reason);
      payload.per_iteration_summary.forEach((summary) => {
        upsertAutobuildRound(summary.iteration, {
          planName: summary.plan_name,
          runId: summary.run_id,
          outcome: summary.outcome,
          evaluationBrief: summary.evaluation_brief
        });
      });
      appendLog({
        id: `${Date.now()}-autobuild-done`,
        text: `[autobuild] done after ${payload.iterations_run} iteration(s): ${payload.stop_reason}\n`,
        source: "system"
      });
      setIsAutobuilding(false);
    });

    return () => {
      isMounted = false;
      unsubscribeOutput();
      unsubscribeDone();
      unsubscribeStep();
      unsubscribeCancelled();
      unsubscribeDecision();
      unsubscribeAutobuildStatus();
      unsubscribeAutobuildPlan();
      unsubscribeAutobuildDone();
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("planEditor", planInput);
  }, [planInput]);

  useEffect(() => {
    window.localStorage.setItem("requirementInput", requirement);
  }, [requirement]);

  useEffect(() => {
    if (!logRef.current) return;
    logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [logEntries]);

  const logText = useMemo(() => logEntries.map((entry) => entry.text).join(""), [logEntries]);

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1>AI Dev Orchestrator</h1>
          <p className="muted">Workspace: {workspacePath ?? "(not set)"}</p>
          <p className="muted">Runs: {runsRoot ?? "(loading...)"}</p>
          <p className="muted">
            Step: {stepProgress ? `${stepProgress.current}/${stepProgress.total}` : "(idle)"}
          </p>
          <p className="muted">
            Auto Build:{" "}
            {autobuildStatus
              ? `iter ${autobuildStatus.iteration} (${autobuildStatus.phase})`
              : "(idle)"}
          </p>
          <p className="muted">
            Requirement: {requirement.trim() ? requirement.trim().slice(0, 80) : "(not set)"}
          </p>
          {apiError && <p className="error">{apiError}</p>}
        </div>
        <div className="actions">
          <button className="secondary" onClick={selectWorkspace}>
            Select Workspace
          </button>
          <button
            className="primary"
            onClick={startAutobuild}
            disabled={isRunning || isAutobuilding || !!decision}
          >
            Auto Build (2x)
          </button>
          <button className="primary" onClick={runPlan} disabled={isRunning || !!decision}>
            Run Plan
          </button>
          <button className="secondary" onClick={cancelRun} disabled={!isRunning && !isAutobuilding}>
            Cancel
          </button>
        </div>
      </header>

      <section className="panel">
        <h2>Plan JSON</h2>
        <textarea
          className="input"
          value={planInput}
          rows={10}
          onChange={(event) => setPlanInput(event.target.value)}
        />
        {planError && <p className="error">{planError}</p>}
        {generateError && (
          <p className="error">
            {generateError.startsWith("Planner JSON parse error")
              ? `Parse Error: ${generateError}`
              : generateError.startsWith("Plan schema validation failed")
                ? `Schema Error: ${generateError}`
                : generateError}
          </p>
        )}
        {dirtyGuardMessage && (
          <div className="guard">
            <p className="error">{dirtyGuardMessage}</p>
            <button
              className="secondary"
              onClick={async () => {
                setVerifyOnlyRequested(true);
                try {
                  await runPlan(true);
                } finally {
                  setVerifyOnlyRequested(false);
                }
              }}
              disabled={isRunning}
            >
              Continue (verify-only)
            </button>
          </div>
        )}
        {isGenerating && <p className="muted">Generating plan...</p>}
        <div className="actions">
          <button className="primary" onClick={generatePlan} disabled={isGenerating}>
            Generate Plan
          </button>
          <button className="secondary" onClick={resetPlan}>
            Use Default Plan
          </button>
        </div>
      </section>

      <section className="panel">
        <h2>Requirement</h2>
        <textarea
          className="input"
          value={requirement}
          rows={4}
          onChange={(event) => setRequirement(event.target.value)}
          placeholder="Describe your requirement..."
        />
      </section>

      <section className="panel">
        <h2>Auto Build Timeline</h2>
        {autobuildStopReason && <p className="muted">Stopped: {autobuildStopReason}</p>}
        {autobuildRuns.length === 0 && <p className="muted">No autobuild runs yet.</p>}
        {autobuildRuns.map((round) => (
          <details key={round.iteration}>
            <summary>
              Round {round.iteration} — {round.planName ?? "(planning)"} — {round.runId ?? "(no run id)"} —{" "}
              {round.outcome ?? "in progress"}
            </summary>
            {round.evaluationBrief && <p className="muted">Eval: {round.evaluationBrief}</p>}
            {round.planJson && (
              <pre className="log">{round.planJson}</pre>
            )}
            <div className="actions">
              {round.planJson && (
                <button
                  className="secondary"
                  onClick={() => setPlanInput(round.planJson ?? "")}
                >
                  Use this plan
                </button>
              )}
              {round.runId && (
                <button className="secondary" onClick={() => copyRunId(round.runId ?? "")}>
                  Copy run_id
                </button>
              )}
            </div>
          </details>
        ))}
      </section>

      {decision && (
        <section className="panel">
          <h2>Decision Required</h2>
          <p>检测到依赖变更，需要人工确认。</p>
          <p>变更文件：</p>
          <ul className="decision-list">
            {decision.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
          <div className="actions">
            <button className="primary" onClick={() => resolveDecision("approved")}>
              Approve
            </button>
            <button className="secondary" onClick={() => resolveDecision("rejected")}>
              Reject
            </button>
          </div>
        </section>
      )}

      <section className="panel">
        <h2>Logs</h2>
        <div className="actions">
          <button
            className="secondary"
            onClick={() => setShowClearLogs((prev) => !prev)}
          >
            Toggle Clear Logs
          </button>
          {showClearLogs && (
            <button className="secondary" onClick={clearLogs} disabled={!logEntries.length}>
              Clear Logs
            </button>
          )}
        </div>
        <pre className="log" ref={logRef}>
          {logText || "No logs yet."}
        </pre>
      </section>
    </div>
  );
};

export default App;
// dirty test
