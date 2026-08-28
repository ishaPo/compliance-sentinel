import type { CheckLogEntry, VersionEntry } from "@/lib/types";
import { formatDateTime } from "@/lib/format";
import { OutcomeBadge } from "./OutcomeBadge";

interface Props {
  versions: VersionEntry[];
  checkLog: CheckLogEntry[];
  loading: boolean;
}

/**
 * Secondary tab: the full version timeline and every-run check log. Kept
 * out of the primary run view so it doesn't compete with the three panels
 * the assignment explicitly asks for, but still fully available for anyone
 * who wants to see the persistence model at work.
 */
export function VersionHistoryView({ versions, checkLog, loading }: Props) {
  if (loading) {
    return <div className="panel-body empty-state">Loading history…</div>;
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
            versions.map((v) => (
              <div className="history-row" key={v.version}>
                <div>
                  <div className="history-row-main">
                    Version {v.version}
                    {v.report === null ? " (baseline)" : ""}
                  </div>
                  <div className="history-row-detail">
                    {v.sections.length} section(s)
                    {v.report ? `, ${v.report.changes.length} meaningful change(s), ${v.report.cosmeticCount} cosmetic` : ""}
                  </div>
                </div>
                <div className="history-row-time">{formatDateTime(v.timestamp)}</div>
              </div>
            ))
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
            checkLog.map((entry, i) => (
              <div className="history-row" key={i}>
                <div>
                  <div className="history-row-main">
                    <OutcomeBadge outcome={entry.outcome} />
                  </div>
                  {entry.detail && <div className="history-row-detail">{entry.detail}</div>}
                </div>
                <div className="history-row-time">{formatDateTime(entry.timestamp)}</div>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
