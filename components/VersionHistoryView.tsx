"use client";

import { useState } from "react";
import type { CheckLogEntry, VersionEntry } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { OutcomeBadge } from "./OutcomeBadge";
import { ChangeCard } from "./ChangeReportView";

interface Props {
  versions: VersionEntry[];
  checkLog: CheckLogEntry[];
  loading: boolean;
}

/**
 * Vercel KV is already the single store behind both lists here — every
 * version's full report (interpretation, severity, reasoning, modelUsed per
 * change) is fetched from `versions:<urlHash>` right alongside the summary
 * counts, it just wasn't rendered before. Each row below is click-to-expand
 * so that full detail is one click away instead of a second place to look,
 * and a check-log entry that refers to a version (`versionRef`) can jump
 * straight to it — so the two panels read as one linked timeline over the
 * same KV data rather than two disconnected views.
 */
export function VersionHistoryView({ versions, checkLog, loading }: Props) {
  const [expandedVersion, setExpandedVersion] = useState<number | null>(null);

  if (loading) {
    return <div className="panel-body empty-state">Loading history…</div>;
  }

  function jumpToVersion(versionRef: number | undefined) {
    if (versionRef === undefined) return;
    setExpandedVersion(versionRef);
    // Rows render inside an overflow:auto panel, so scrollIntoView needs to
    // run after the expand state above has actually painted the target row.
    requestAnimationFrame(() => {
      document.getElementById(`version-row-${versionRef}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
  }

  return (
    <div className="history-grid">
      <div className="panel">
        <div className="panel-header">
          <h2>Version history</h2>
          <span className="count">{versions.length}</span>
        </div>
        <div className="panel-body">
          {versions.length === 0 ? (
            <div className="empty-state">No versions saved yet for this URL — run the agent to create a baseline.</div>
          ) : (
            versions.map((v) => {
              const isExpanded = expandedVersion === v.version;
              const changes = v.report?.changes ?? [];
              return (
                <div className="history-row-wrap" key={v.version} id={`version-row-${v.version}`}>
                  <button
                    className="history-row history-row-clickable"
                    onClick={() => setExpandedVersion(isExpanded ? null : v.version)}
                    aria-expanded={isExpanded}
                  >
                    <div>
                      <div className="history-row-main">
                        <span className={`expand-caret ${isExpanded ? "open" : ""}`}>▸</span>
                        Version {v.version}
                        {v.report === null ? " (baseline)" : ""}
                      </div>
                      <div className="history-row-detail">
                        {v.sections.length} section(s)
                        {v.report ? `, ${v.report.changes.length} meaningful change(s), ${v.report.cosmeticCount} cosmetic` : ""}
                      </div>
                    </div>
                    <div className="history-row-time">{formatDateTime(v.timestamp)}</div>
                  </button>
                  {isExpanded && (
                    <div className="history-row-body">
                      {v.report === null ? (
                        <div className="empty-state small">This is the baseline snapshot — nothing to compare it against yet.</div>
                      ) : changes.length === 0 ? (
                        <div className="empty-state small">
                          Only cosmetic changes at this version ({v.report.cosmeticCount}) — nothing detailed to show.
                        </div>
                      ) : (
                        changes.map((c) => <ChangeCard key={c.sectionId} change={c} />)
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-header">
          <h2>Check log</h2>
          <span className="count">{checkLog.length}</span>
        </div>
        <div className="panel-body">
          {checkLog.length === 0 ? (
            <div className="empty-state">No checks recorded yet for this URL.</div>
          ) : (
            checkLog.map((entry, i) => {
              const clickable = entry.versionRef !== undefined && versions.some((v) => v.version === entry.versionRef);
              return (
                <div
                  className={`history-row ${clickable ? "history-row-clickable" : ""}`}
                  key={i}
                  {...(clickable ? { role: "button", tabIndex: 0, onClick: () => jumpToVersion(entry.versionRef) } : {})}
                >
                  <div>
                    <div className="history-row-main">
                      <OutcomeBadge outcome={entry.outcome} />
                    </div>
                    {entry.detail && <div className="history-row-detail">{entry.detail}</div>}
                    {clickable && <div className="history-row-detail history-row-link">→ view version {entry.versionRef} in full</div>}
                  </div>
                  <div className="history-row-time">{formatDateTime(entry.timestamp)}</div>
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
