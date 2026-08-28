import type { CheckLogEntry } from "@/lib/types";

const LABELS: Record<CheckLogEntry["outcome"], string> = {
  baseline_created: "Baseline",
  no_change: "No change",
  change_detected: "Change detected",
  error: "Error",
};

export function OutcomeBadge({ outcome }: { outcome: CheckLogEntry["outcome"] }) {
  return <span className={`chip outcome-${outcome}`}>{LABELS[outcome]}</span>;
}
