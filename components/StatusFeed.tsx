import { formatTime } from "@/lib/format";

export interface FeedMessage {
  time: string;
  text: string;
}

/**
 * The live, real-time "what is the agent doing right now" feed — a plain
 * scrolling list of short status lines, deliberately separate from the
 * Agent Trail panel. This answers "which URL / what it's doing, updated in
 * real time"; the trail answers "every action taken and why" with full
 * reasoning. Keeping them apart avoids the report/trail feeling repetitive.
 */
export function StatusFeed({ messages }: { messages: FeedMessage[] }) {
  if (messages.length === 0) {
    return (
      <div className="panel-body empty-state">
        No run yet. Enter a URL above and hit Run to watch the agent work in real time.
      </div>
    );
  }

  return (
    <div className="panel-body">
      <div className="feed-list">
        {messages.map((m, i) => (
          <div className="feed-item" key={i}>
            <span className="feed-time">{formatTime(m.time)}</span>
            {m.text}
          </div>
        ))}
      </div>
    </div>
  );
}
