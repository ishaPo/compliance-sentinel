"use client";

import { useEffect, useRef, useState } from "react";
import type { CheckLogEntry, RunEvent, TrailEntry, VersionEntry } from "@/lib/types";
import { StatusFeed, type FeedMessage } from "@/components/StatusFeed";
import { AgentTrailView } from "@/components/AgentTrailView";
import { ChangeReportView } from "@/components/ChangeReportView";
import { VersionHistoryView } from "@/components/VersionHistoryView";

const DEFAULT_URL = "https://corvantixtargetsite.vercel.app/";

type Tab = "run" | "history";

interface LastResult {
  outcome: CheckLogEntry["outcome"];
  version?: VersionEntry;
}

export default function Page() {
  const [url, setUrl] = useState(DEFAULT_URL);
  const [running, setRunning] = useState(false);
  const [feed, setFeed] = useState<FeedMessage[]>([]);
  const [trail, setTrail] = useState<TrailEntry[]>([]);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [tab, setTab] = useState<Tab>("run");

  const [historyVersions, setHistoryVersions] = useState<VersionEntry[]>([]);
  const [historyCheckLog, setHistoryCheckLog] = useState<CheckLogEntry[]>([]);
  const [usingRealStorage, setUsingRealStorage] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);

  const esRef = useRef<EventSource | null>(null);
  const finishedRef = useRef(false);
  const currentUrlRef = useRef(url);

  async function fetchHistory(targetUrl: string) {
    if (!targetUrl) return;
    setHistoryLoading(true);
    try {
      const res = await fetch(`/api/history?url=${encodeURIComponent(targetUrl)}`);
      if (!res.ok) return;
      const data = await res.json();
      setHistoryVersions(data.versions ?? []);
      setHistoryCheckLog(data.checkLog ?? []);
      setUsingRealStorage(Boolean(data.usingRealStorage));
    } catch {
      // Best-effort — history is a convenience view, not the critical path.
    } finally {
      setHistoryLoading(false);
    }
  }

  useEffect(() => {
    fetchHistory(DEFAULT_URL);
    return () => {
      esRef.current?.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function pushFeed(text: string) {
    setFeed((prev) => [...prev, { time: new Date().toISOString(), text }]);
  }

  function runAgent() {
    const targetUrl = url.trim();
    if (!targetUrl || running) return;

    esRef.current?.close();
    finishedRef.current = false;
    currentUrlRef.current = targetUrl;

    setRunning(true);
    setFeed([]);
    setTrail([]);
    setErrorMessage(null);
    setLastResult(null);
    pushFeed(`Connecting to run agent for ${targetUrl}`);

    const es = new EventSource(`/api/run?url=${encodeURIComponent(targetUrl)}`);
    esRef.current = es;

    es.onmessage = (ev) => {
      let event: RunEvent;
      try {
        event = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (event.type === "status") {
        pushFeed(event.message);
      } else if (event.type === "trail") {
        setTrail((prev) => [...prev, event.entry]);
      } else if (event.type === "done") {
        finishedRef.current = true;
        setTrail(event.trail);
        setLastResult({ outcome: event.outcome, version: event.version });
        pushFeed(`Run finished: ${event.outcome.replace(/_/g, " ")}`);
        setRunning(false);
        es.close();
        fetchHistory(targetUrl);
      } else if (event.type === "fatal") {
        finishedRef.current = true;
        setErrorMessage(event.message);
        pushFeed(`Run failed: ${event.message}`);
        setRunning(false);
        es.close();
        fetchHistory(targetUrl);
      }
    };

    es.onerror = () => {
      // The server closes the stream after "done"/"fatal" — browsers treat
      // that as a connection error and would otherwise auto-reconnect.
      // Ignore it once we've already gotten a real terminal event.
      if (finishedRef.current) return;
      setErrorMessage("Lost connection to the server before the run finished.");
      setRunning(false);
      es.close();
    };
  }

  const runningLabel = running ? "Running" : errorMessage ? "Error" : lastResult ? "Done" : "Idle";

  return (
    <div className="shell">
      <div className="header">
        <div className="header-title">
          <h1>Compliance Sentinel</h1>
          <span className="header-subtitle">Autonomous change detection for pharma HCP web pages</span>
        </div>
        <span className={`storage-indicator ${usingRealStorage ? "real" : ""}`}>
          storage: {usingRealStorage ? "Vercel KV" : "in-memory (dev fallback)"}
        </span>
      </div>

      <div className="control-bar">
        <input
          className="url-input"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://example.com"
          onKeyDown={(e) => {
            if (e.key === "Enter") runAgent();
          }}
        />
        <button className="run-button" onClick={runAgent} disabled={running}>
          {running ? "Running…" : "Run"}
        </button>
        <span className="run-state">
          <span className={`pulse-dot ${running ? "running" : errorMessage ? "error" : lastResult ? "done" : ""}`} />
          {runningLabel}
        </span>
      </div>

      {errorMessage && <div className="error-banner">{errorMessage}</div>}

      <div className="tab-bar">
        <button className={`tab-button ${tab === "run" ? "active" : ""}`} onClick={() => setTab("run")}>
          Run
        </button>
        <button
          className={`tab-button ${tab === "history" ? "active" : ""}`}
          onClick={() => {
            setTab("history");
            fetchHistory(currentUrlRef.current || url);
          }}
        >
          Version history
        </button>
      </div>

      {tab === "run" ? (
        <div className="run-grid">
          <div className="panel panel-feed">
            <div className="panel-header">
              <h2>Live status</h2>
              <span className="count">{feed.length}</span>
            </div>
            <StatusFeed messages={feed} />
          </div>

          <div className="panel panel-report">
            <div className="panel-header">
              <h2>Change report</h2>
              {lastResult?.version && <span className="count">v{lastResult.version.version}</span>}
            </div>
            <ChangeReportView
              running={running}
              errorMessage={errorMessage}
              outcome={lastResult?.outcome ?? null}
              version={lastResult?.version ?? null}
            />
          </div>

          <div className="panel panel-trail">
            <div className="panel-header">
              <h2>Agent trail</h2>
              <span className="count">{trail.length}</span>
            </div>
            <AgentTrailView trail={trail} />
          </div>
        </div>
      ) : (
        <VersionHistoryView versions={historyVersions} checkLog={historyCheckLog} loading={historyLoading} />
      )}

      <div className="footer-note">
        Built for the Indegene Associate Manager, Product Management (Applied AI) take-home assignment.
      </div>
    </div>
  );
}
