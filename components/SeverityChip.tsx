import type { Severity } from "@/lib/types";

export function SeverityChip({ severity }: { severity: Severity }) {
  return <span className={`chip sev-${severity}`}>{severity}</span>;
}
