import React, { useEffect, useMemo, useRef, useState } from "react";

type LogEntry = {
  id: string;
  text: string;
  source: "stdout" | "stderr" | "system";
};

const PLAN_FILENAME = "plan.md";

const App = () => {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [runsRoot, setRunsRoot] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    { id: "boot", text: "Ready.\n", source: "system" }
  ]);
  const [isRunning, setIsRunning] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [stepProgress, setStepProgress] = useState<{ current: number; total: number } | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  const [planExists, setPlanExists] = useState<boolean | null>(null);
  const logRef = useRef<HTMLPreElement | null>(null);

  const appendLog = (entry: LogEntry) => {
    setLogEntries((prev) => [...prev, entry]);
  };

  const selectWorkspace = async () => {
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }
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
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }
    if (planExists === false) {
      appendLog({
        id: `${Date.now()}-plan-missing`,
        text: "No plan.md found.\n",
        source: "system"
      });
      return;
    }

    setIsRunning(true);
    appendLog({
      id: `${Date.now()}-run`,
      text: `Running plan from ${PLAN_FILENAME}\n`,
      source: "system"
    });

    try {
      const response = await window.api.runPlan({
        workspacePath,
        planPath: PLAN_FILENAME
      });
      if (response.ok) {
        setCurrentRunId(response.result);
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

  const cancelRun = async () => {
    if (!currentRunId) return;
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }
    const cancelled = await window.api.cancelRun(currentRunId);
    if (!cancelled) {
      appendLog({
        id: `${Date.now()}-cancel-failed`,
        text: "Cancel failed (no active run).\n",
        source: "system"
      });
    }
  };

  const createSamplePlan = async () => {
    if (!workspacePath) {
      appendLog({
        id: `${Date.now()}-plan-create-error`,
        text: "Workspace not set.\n",
        source: "system"
      });
      return;
    }
    if (!window.api) {
      setApiError("preload not loaded, IPC unavailable");
      return;
    }
    try {
      const result = await window.api.createSamplePlan(workspacePath);
      setPlanExists(true);
      appendLog({
        id: `${Date.now()}-plan-created`,
        text: `Created sample plan at ${result.path}\n`,
        source: "system"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog({
        id: `${Date.now()}-plan-create-error`,
        text: `Failed to create plan.md: ${message}\n`,
        source: "system"
      });
    }
  };

  useEffect(() => {
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

    return () => {
      isMounted = false;
      unsubscribeOutput();
      unsubscribeDone();
      unsubscribeStep();
      unsubscribeCancelled();
    };
  }, []);

  useEffect(() => {
    if (!window.api) {
      return;
    }
    let isMounted = true;
    if (workspacePath) {
      window.api.checkPlanExists(workspacePath).then((exists) => {
        if (isMounted) setPlanExists(exists);
      });
    } else if (isMounted) {
      setPlanExists(null);
    }
    return () => {
      isMounted = false;
    };
  }, [workspacePath]);

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
          <p className="muted">Plan file: {PLAN_FILENAME}</p>
          {planExists === false && <p className="error">No plan.md found</p>}
          {apiError && <p className="error">{apiError}</p>}
        </div>
        <div className="actions">
          <button className="secondary" onClick={selectWorkspace}>
            Select Workspace
          </button>
          {planExists === false && (
            <button className="secondary" onClick={createSamplePlan} disabled={isRunning}>
              Create Sample Plan
            </button>
          )}
          <button className="primary" onClick={runPlan} disabled={isRunning}>
            Run Plan
          </button>
          <button className="secondary" onClick={cancelRun} disabled={!isRunning}>
            Cancel
          </button>
        </div>
      </header>

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
