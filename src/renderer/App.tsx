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

const defaultPlan = {
  plan_name: "Default plan",
  steps: [
    { type: "note", text: "Starting plan." },
    { type: "cmd", command: "git status -sb" }
  ]
} as const;

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

    setIsRunning(true);
    appendLog({
      id: `${Date.now()}-run`,
      text: `Running plan: ${defaultPlan.plan_name}\n`,
      source: "system"
    });

    try {
      const runId = await window.api.runPlan({ workspacePath, plan: defaultPlan });
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
