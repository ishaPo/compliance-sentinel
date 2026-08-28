import type { TrailEntry } from "@/lib/types";
import { formatTime } from "@/lib/format";

/**
 * The accountability log: every action the agent took, and — for anything
 * that involved a judgment call (a retry, a redirect, a classification, a
 * save/skip decision, a provider fallback) — why. Routine steps omit
 * `reasoning`; decision points always include it.
 */
export function AgentTrailView({ trail }: { trail: TrailEntry[] }) {
  if (trail.length === 0) {
    return (
      <div className="panel-body empty-state">
        No actions logged yet. Every fetch, retry, redirect decision, and classification the agent makes will appear here with its reasoning.
      </div>
    );
  }

  return (
    <div className="panel-body">
      <div className="trail-list">
        {trail.map((entry, i) => (
          <div className={`trail-item ${entry.level}`} key={i}>
            <div className="trail-action">
              {entry.action}
              <span className={`trail-level-tag ${entry.level}`}>{entry.level}</span>
            </div>
            {entry.detail && <div className="trail-detail">{entry.detail}</div>}
            {entry.reasoning && <div className="trail-reasoning">{entry.reasoning}</div>}
            <div className="trail-time">{formatTime(entry.timestamp)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
