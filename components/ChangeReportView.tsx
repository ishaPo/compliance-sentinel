"use client";

import { useState } from "react";
import type { CheckLogEntry, InterpretedChange, VersionEntry } from "@/lib/types";
import { SeverityChip } from "./SeverityChip";

interface Props {
  running: boolean;
  errorMessage: string | null;
  outcome: CheckLogEntry["outcome"] | null;
  version: VersionEntry | null;
}

/**
 * The structured output: organised by section, showing what changed, its
 * before/after text, and a one-line interpretation of why it might matter —
 * the literal deliverable the assignment asks for. Cosmetic/functional-only
 * changes are counted but not detailed here, to keep the report focused on
 * what a compliance reviewer actually needs to read.
 */
export function ChangeReportView({ running, errorMessage, outcome, version }: Props) {
  if (errorMessage) {
    return (
      <div className="panel-body empty-state">
        The run failed before a report could be produced — see the error above and the agent trail for details.
      </div>
    );
  }

  if (!outcome) {
    return (
      <div className="panel-body empty-state">
        {running
          ? "Agent is working — the report will appear here once the run completes."
          : "Enter a URL and hit Run. The first run saves a baseline snapshot; every run after that produces a change report here."}
      </div>
    );
  }

  if (outcome === "baseline_created") {
    return (
      <div className="panel-body empty-state">
        First check for this URL — saved as the baseline snapshot (version {version?.version ?? 1}). Run again after the page changes to see a change report.
      </div>
    );
  }

  if (outcome === "no_change") {
    return (
      <div className="panel-body empty-state">
        No meaningful change since the last saved version. Purely cosmetic or markup-only edits, if any, are logged in the agent trail but don't count as meaningful enough to version.
      </div>
    );
  }

  if (outcome === "error") {
    return (
      <div className="panel-body empty-state">
        The run failed — see the error above and the agent trail for details.
      </div>
    );
  }

  const report = version?.report ?? null;
  if (!report || report.changes.length === 0) {
    return <div className="panel-body empty-state">No report data available for this run.</div>;
  }

  return (
    <div className="panel-body">
      <div className="report-summary">
        <span>
          <strong>{report.changes.length}</strong> meaningful change{report.changes.length === 1 ? "" : "s"}
        </span>
        {version && (
          <span>
            saved as version <strong>{version.version}</strong>
          </span>
        )}
        {report.cosmeticCount > 0 && (
          <span>
            <strong>{report.cosmeticCount}</strong> cosmetic-only change{report.cosmeticCount === 1 ? "" : "s"} (not detailed below)
          </span>
        )}
      </div>
      {report.changes.map((c) => (
        <ChangeCard key={c.sectionId} change={c} />
      ))}
    </div>
  );
}

function ChangeCard({ change }: { change: InterpretedChange }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="change-card">
      <div className="change-card-header">
        <span className="change-heading">{change.sectionHeading}</span>
        <SeverityChip severity={change.severity} />
      </div>
      <div className="change-interpretation">{change.interpretation}</div>
      <div className="before-after">
        <div className="ba-block before">
          <span className="ba-label">Before</span>
          {change.before || "—"}
        </div>
        <div className="ba-block after">
          <span className="ba-label">After</span>
          {change.after || "—"}
        </div>
      </div>
      <button className="expand-toggle" onClick={() => setExpanded((v) => !v)}>
        {expanded ? "Hide reasoning" : "Why this classification & severity?"}
      </button>
      {expanded && (
        <div className="expand-body">
          {change.reasoning}
          <span className="model-used">Interpreted by: {change.modelUsed}</span>
        </div>
      )}
    </div>
  );
}
