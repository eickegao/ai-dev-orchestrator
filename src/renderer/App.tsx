import React, { useEffect, useMemo, useRef, useState } from "react";

type LogEntry = {
  id: string;
  text: string;
  source: "stdout" | "stderr" | "system";
};

const App = () => {
  const [workspacePath, setWorkspacePath] = useState<string | null>(null);
  const [runsRoot, setRunsRoot] = useState<string | null>(null);
  const [logEntries, setLogEntries] = useState<LogEntry[]>([
    { id: "boot", text: "Ready.\n", source: "system" }
  ]);
  const [isRunning, setIsRunning] = useState(false);
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

  const runGitStatus = async () => {
    if (!workspacePath) {
      appendLog({
        id: `${Date.now()}-error`,
        text: "Workspace not set.\n",
        source: "system"
      });
      return;
    }

    setIsRunning(true);
    appendLog({
      id: `${Date.now()}-run`,
      text: "Running: git status -sb\n",
      source: "system"
    });

    try {
      await window.api.runGitStatus(workspacePath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      appendLog({
        id: `${Date.now()}-run-error`,
        text: `${message}\n`,
        source: "system"
      });
      setIsRunning(false);
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
        source: payload.source === "stderr" ? "stderr" : "stdout"
      });
    });

    const unsubscribeDone = window.api.onRunDone((payload) => {
      appendLog({
        id: `${Date.now()}-done`,
        text: `Process finished (exit ${payload.exitCode}).\n`,
        source: payload.exitCode === 0 ? "system" : "stderr"
      });
      setIsRunning(false);
    });

    return () => {
      isMounted = false;
      unsubscribeOutput();
      unsubscribeDone();
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
        </div>
        <div className="actions">
          <button className="secondary" onClick={selectWorkspace}>
            Select Workspace
          </button>
          <button className="primary" onClick={runGitStatus} disabled={isRunning}>
            Run git status
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
