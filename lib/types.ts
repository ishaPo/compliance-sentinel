// Shared types for the compliance-monitoring agent.

export type Severity = "none" | "low" | "medium" | "high";
export type ChangeClass = "functional" | "content";

/** A single extracted section of a page, identified by its heading. */
export interface ExtractedSection {
  id: string; // slug derived from heading text, stable across runs
  heading: string;
  text: string; // normalized, whitespace-collapsed text content
  /**
   * A lightweight structural signature (tag names + class lists within the
   * section, text stripped out) used to detect markup/CSS-only changes —
   * the section "looks different" even though its words didn't change.
   * Deliberately coarse: this is not a full DOM/CSS diff, it's a cheap,
   * explainable proxy for "functional" vs "content" changes, scoped to a
   * POC's time budget rather than pretending to be pixel-level.
   */
  structureFingerprint: string;
}

export interface ExtractResult {
  finalUrl: string; // after following redirects
  redirected: boolean;
  crossDomainRedirect: boolean;
  sections: ExtractedSection[];
  fetchedAt: string; // ISO timestamp
}

/** One distinct changed chunk within a section, before interpretation. */
export interface RawChange {
  sectionId: string;
  sectionHeading: string;
  before: string;
  after: string;
  /** Cheap heuristic pre-classification; the LLM may override this. */
  heuristicClass: ChangeClass;
}

/** A changed chunk after the LLM has interpreted it. */
export interface InterpretedChange {
  sectionId: string;
  sectionHeading: string;
  before: string;
  after: string;
  classification: ChangeClass;
  severity: Severity;
  interpretation: string; // the one-line "why it might matter"
  reasoning: string; // the model's justification for classification + severity
  modelUsed: string; // e.g. "gemini-2.0-flash" or "llama-3.3-70b (openrouter fallback)" or "unavailable"
}

/** The full report generated for one run that found meaningful changes. */
export interface ChangeReport {
  changes: InterpretedChange[];
  cosmeticCount: number; // functional-only changes, not detailed in the report
}

/** One persisted entry in a URL's version history — only meaningful changes. */
export interface VersionEntry {
  version: number;
  timestamp: string; // ISO
  sections: ExtractedSection[]; // full snapshot at this version
  report: ChangeReport | null; // null for version 1 (baseline, nothing to compare)
}

/** One persisted entry in a URL's check log — every run, regardless of outcome. */
export interface CheckLogEntry {
  timestamp: string; // ISO
  outcome: "baseline_created" | "no_change" | "change_detected" | "error";
  versionRef?: number; // set when outcome is baseline_created or change_detected
  detail?: string; // short human-readable note, e.g. an error message
}

/** One line in the agent trail — a decision or action taken during a run. */
export interface TrailEntry {
  timestamp: string; // ISO
  action: string; // short present-tense description, e.g. "Followed redirect"
  detail?: string; // supporting detail, e.g. the actual URL
  reasoning?: string; // populated for decision points, omitted for routine steps
  level: "info" | "decision" | "warning" | "error";
}

/** Server-Sent Event payloads streamed to the client during a run. */
export type RunEvent =
  | { type: "trail"; entry: TrailEntry }
  | { type: "status"; message: string }
  | {
      type: "done";
      outcome: CheckLogEntry["outcome"];
      version?: VersionEntry;
      trail: TrailEntry[];
    }
  | { type: "fatal"; message: string };
