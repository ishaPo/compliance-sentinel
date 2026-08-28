import type { ChangeClass, ExtractedSection, RawChange, TrailEntry } from "./types";

type Trail = (entry: Omit<TrailEntry, "timestamp">) => void;

export interface DiffResult {
  changes: RawChange[];
  /** Sections whose text AND structure fingerprint were both unchanged. */
  unchangedCount: number;
}

/**
 * Compares two section snapshots by id and produces a list of raw changes,
 * each pre-classified by a cheap heuristic:
 *   - text differs                              -> "content"   (dominant signal)
 *   - text identical, structureFingerprint diff  -> "functional" (CSS/markup only)
 *   - a section only in the new snapshot         -> "content"   (something new appeared)
 *   - a section only in the old snapshot         -> "content"   (something disappeared)
 *
 * This heuristic classification is a starting point, not the final word — the
 * LLM interpretation layer sees both the heuristic and the actual before/after
 * text and may override it (e.g. a text change so trivial — whitespace,
 * punctuation — that it's actually cosmetic despite differing character-for-
 * character). That's why RawChange.heuristicClass is separate from
 * InterpretedChange.classification.
 */
export function diffSections(
  oldSections: ExtractedSection[],
  newSections: ExtractedSection[],
  trail: Trail
): DiffResult {
  const oldById = new Map(oldSections.map((s) => [s.id, s]));
  const newById = new Map(newSections.map((s) => [s.id, s]));

  const changes: RawChange[] = [];
  let unchangedCount = 0;

  // Walk new sections in page order — covers both "still present" and "added".
  for (const section of newSections) {
    const prev = oldById.get(section.id);

    if (!prev) {
      const heuristicClass: ChangeClass = "content";
      changes.push({
        sectionId: section.id,
        sectionHeading: section.heading,
        before: "(section did not exist in the previous snapshot)",
        after: section.text,
        heuristicClass,
      });
      trail({
        action: "New section appeared",
        detail: section.heading,
        reasoning: "This section wasn't present in the last saved snapshot — a section appearing is treated as a content change worth flagging, not silently ignored.",
        level: "decision",
      });
      continue;
    }

    const textChanged = prev.text !== section.text;
    const structureChanged = prev.structureFingerprint !== section.structureFingerprint;

    if (!textChanged && !structureChanged) {
      unchangedCount++;
      continue;
    }

    const heuristicClass: ChangeClass = textChanged ? "content" : "functional";
    changes.push({
      sectionId: section.id,
      sectionHeading: section.heading,
      before: prev.text,
      after: section.text,
      heuristicClass,
    });
    trail({
      action: textChanged ? "Content change detected" : "Structural/markup-only change detected",
      detail: section.heading,
      reasoning: textChanged
        ? "Extracted text differs from the previous snapshot — classifying as a content change pending LLM review."
        : "Wording is identical, but the section's tag/class signature changed — likely a styling or layout edit rather than a wording change. Text-only extraction can't see CSS directly, so this structural fingerprint is what makes 'functional' changes detectable at all.",
      level: "decision",
    });
  }

  // Anything left in the old snapshot but absent from the new one was removed.
  for (const prev of oldSections) {
    if (!newById.has(prev.id)) {
      changes.push({
        sectionId: prev.id,
        sectionHeading: prev.heading,
        before: prev.text,
        after: "(section no longer present)",
        heuristicClass: "content",
      });
      trail({
        action: "Section removed",
        detail: prev.heading,
        reasoning: "This section was present in the last saved snapshot but is missing now — flagging as a content change rather than dropping it silently.",
        level: "decision",
      });
    }
  }

  return { changes, unchangedCount };
}
