import React, { useEffect, useMemo, useRef, useState } from "react";

type LogEntry = {
  id: string;
  text: string;
  source: "stdout" | "stderr" | "system";
};

type DecisionState = {
  runId: string;
  files: string[];
};

type TaskPlan = {
  plan_name: string;
  steps: Array<{ type: "cmd"; command: string } | { type: "note"; message: string }>;
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
  const logRef = useRef<HTMLPreElement | null>(null);

  const appendLog = (entry: LogEntry) => {
    setLogEntries((prev) => [...prev, entry]);
  };

  const selectWorkspace = async () => {
    const selected = await window.api.selectWorkspace();
    if (selected) {
      setWorkspacePath(selected);
      appendLog({
        id: `${Date.now()}-workspace`,
        text: `Workspace set: ${selected}\n`,
        source: "system"
      });
    }
  };

  const parsePlan = (value: string): TaskPlan => {
    const parsed = JSON.parse(value) as TaskPlan;
    if (!parsed || typeof parsed.plan_name !== "string") {
      throw new Error("plan_name must be a string");
    }
    if (!Array.isArray(parsed.steps)) {
      throw new Error("steps must be an array");
    }
    for (const step of parsed.steps) {
      if (!step || typeof step !== "object") {
        throw new Error("step must be an object");
      }
      if (step.type !== "note" && step.type !== "cmd") {
        throw new Error("step.type must be note or cmd");
      }
      if (step.type === "note" && typeof (step as { message?: string }).message !== "string") {
        throw new Error("note step requires message:string");
      }
      if (step.type === "cmd" && typeof (step as { command?: string }).command !== "string") {
        throw new Error("cmd step requires command:string");
      }
    }
    return parsed;
  };

  const runPlan = async () => {
    if (!workspacePath) {
      appendLog({
        id: `${Date.now()}-error`,
        text: "Workspace not set.\n",
        source: "system"
      });
      return;
    }

    if (decision) {
      appendLog({
        id: `${Date.now()}-decision-pending`,
        text: "Decision required before running again.\n",
        source: "system"
      });
      return;
    }

    let plan: TaskPlan;
    try {
      plan = parsePlan(planInput);
      setPlanError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setPlanError(message);
      return;
    }

    setIsRunning(true);
    appendLog({
      id: `${Date.now()}-run`,
      text: `Running plan: ${plan.plan_name}\n`,
      source: "system"
    });

    try {
      const runId = await window.api.runPlan({ workspacePath, plan });
      setCurrentRunId(runId);
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
  };

  const cancelRun = async () => {
    if (!currentRunId) return;
    const cancelled = await window.api.cancelRun(currentRunId);
    if (!cancelled) {
      appendLog({
        id: `${Date.now()}-cancel-failed`,
        text: "Cancel failed (no active run).\n",
        source: "system"
      });
    }
  };

  const resolveDecision = async (result: "approved" | "rejected") => {
    if (!decision) return;
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

    return () => {
      isMounted = false;
      unsubscribeOutput();
      unsubscribeDone();
      unsubscribeStep();
      unsubscribeCancelled();
      unsubscribeDecision();
    };
  }, []);

  useEffect(() => {
    window.localStorage.setItem("planEditor", planInput);
  }, [planInput]);

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
        </div>
        <div className="actions">
          <button className="secondary" onClick={selectWorkspace}>
            Select Workspace
          </button>
          <button className="primary" onClick={runPlan} disabled={isRunning || !!decision}>
            Run Plan
          </button>
          <button className="secondary" onClick={cancelRun} disabled={!isRunning}>
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
        <div className="actions">
          <button className="secondary" onClick={resetPlan}>
            Use Default Plan
          </button>
        </div>
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
        <pre className="log" ref={logRef}>
          {logText || "No logs yet."}
        </pre>
      </section>
    </div>
  );
};

export default App;
