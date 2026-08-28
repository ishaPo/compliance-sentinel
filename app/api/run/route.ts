import { extractPage } from "@/lib/extract";
import { diffSections } from "@/lib/diff";
import { interpretChanges } from "@/lib/interpret";
import { appendCheckLog, appendVersion, getLatestVersion } from "@/lib/storage";
import type { RunEvent, TrailEntry, VersionEntry } from "@/lib/types";
import { canonicalizeUrl } from "@/lib/url";

// This route does real network I/O (fetching the target page, calling an
// LLM) and streams progress the whole time it runs — both reasons it must
// never be statically optimized or cached, and must run on the full Node
// runtime rather than the Edge runtime (cheerio and the Gemini SDK expect
// Node APIs).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Runs one full check of `targetUrl` — fetch, extract, diff against the last
 * saved snapshot, interpret, and save-or-skip a new version — streaming
 * every step out as Server-Sent Events so the UI can show a live status
 * feed and agent trail while the run is still in progress.
 */
function createRunStream(targetUrl: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const trailLog: TrailEntry[] = [];

  return new ReadableStream({
    async start(controller) {
      let closed = false;
      const send = (event: RunEvent) => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      const close = () => {
        if (closed) return;
        closed = true;
        controller.close();
      };
      const trail = (entry: Omit<TrailEntry, "timestamp">) => {
        const full: TrailEntry = { ...entry, timestamp: new Date().toISOString() };
        trailLog.push(full);
        send({ type: "trail", entry: full });
      };
      const status = (message: string) => send({ type: "status", message });

      try {
        status(`Starting run for ${targetUrl}`);
        trail({ action: "Run started", detail: targetUrl, level: "info" });

        let extracted;
        try {
          extracted = await extractPage(targetUrl, trail);
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error while fetching or parsing the page.";
          trail({ action: "Extraction failed", detail: message, level: "error" });
          await appendCheckLog(targetUrl, {
            timestamp: new Date().toISOString(),
            outcome: "error",
            detail: message,
          });
          send({ type: "fatal", message });
          close();
          return;
        }

        status("Loading check history for this URL");
        const previous = await getLatestVersion(targetUrl);

        if (!previous) {
          trail({
            action: "No previous snapshot found",
            reasoning: "First time this URL has been checked — saving this snapshot as the baseline. Future runs will compare against it instead of having nothing to diff.",
            level: "decision",
          });
          const version: VersionEntry = {
            version: 1,
            timestamp: extracted.fetchedAt,
            sections: extracted.sections,
            report: null,
          };
          await appendVersion(targetUrl, version);
          await appendCheckLog(targetUrl, {
            timestamp: extracted.fetchedAt,
            outcome: "baseline_created",
            versionRef: 1,
          });
          trail({
            action: "Baseline saved",
            detail: `Version 1 — ${extracted.sections.length} section(s)`,
            level: "info",
          });
          send({ type: "done", outcome: "baseline_created", version, trail: trailLog });
          close();
          return;
        }

        status("Comparing against the last saved version");
        const { changes, unchangedCount } = diffSections(previous.sections, extracted.sections, trail);
        trail({
          action: "Diff complete",
          detail: `${changes.length} section(s) changed, ${unchangedCount} unchanged`,
          level: "info",
        });

        if (changes.length === 0) {
          trail({
            action: "No changes found",
            reasoning: "Every section's text and structural fingerprint matched the last saved snapshot — nothing to report or save.",
            level: "decision",
          });
          await appendCheckLog(targetUrl, { timestamp: extracted.fetchedAt, outcome: "no_change" });
          send({ type: "done", outcome: "no_change", trail: trailLog });
          close();
          return;
        }

        status(`Interpreting ${changes.length} changed section(s)`);
        const report = await interpretChanges(changes, trail);

        if (report.changes.length === 0) {
          trail({
            action: "All changes were cosmetic",
            detail: `${report.cosmeticCount} functional-only change(s)`,
            reasoning: "Every detected change was classified as markup/CSS-only, not a content change — not meaningful enough to save as a new version, though it was still logged.",
            level: "decision",
          });
          await appendCheckLog(targetUrl, {
            timestamp: extracted.fetchedAt,
            outcome: "no_change",
            detail: `${report.cosmeticCount} cosmetic-only change(s) detected, not saved as a new version.`,
          });
          send({ type: "done", outcome: "no_change", trail: trailLog });
          close();
          return;
        }

        const newVersionNumber = previous.version + 1;
        const version: VersionEntry = {
          version: newVersionNumber,
          timestamp: extracted.fetchedAt,
          sections: extracted.sections,
          report,
        };
        await appendVersion(targetUrl, version);
        await appendCheckLog(targetUrl, {
          timestamp: extracted.fetchedAt,
          outcome: "change_detected",
          versionRef: newVersionNumber,
          detail: `${report.changes.length} meaningful change(s), ${report.cosmeticCount} cosmetic-only`,
        });
        trail({
          action: "New version saved",
          detail: `Version ${newVersionNumber} — ${report.changes.length} meaningful change(s)`,
          level: "info",
        });
        send({ type: "done", outcome: "change_detected", version, trail: trailLog });
        close();
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unexpected error during the run.";
        try {
          await appendCheckLog(targetUrl, {
            timestamp: new Date().toISOString(),
            outcome: "error",
            detail: message,
          });
        } catch {
          // Storage itself failed — nothing more we can persist; the client
          // still gets the fatal event below.
        }
        send({ type: "fatal", message });
        close();
      }
    },
  });
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Hints intermediary proxies not to buffer the stream. Harmless where
      // it doesn't apply; important if Vercel's network sits behind anything
      // that buffers by default.
      "X-Accel-Buffering": "no",
    },
  });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

function normalizeUrl(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed.length) return null;
  return canonicalizeUrl(trimmed);
}

// GET supports a plain browser EventSource (which can only issue GET
// requests) — this is the primary path the frontend's live status feed uses.
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = normalizeUrl(searchParams.get("url"));
  if (!targetUrl) return badRequest("Missing required query parameter: url");
  return sseResponse(createRunStream(targetUrl));
}

// POST is kept for programmatic callers (e.g. curl, tests) that would rather
// send a JSON body than a query string.
export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("Request body must be valid JSON.");
  }
  const targetUrl = normalizeUrl(
    typeof (body as { url?: unknown })?.url === "string" ? ((body as { url: string }).url) : null
  );
  if (!targetUrl) return badRequest("Missing required field: url");
  return sseResponse(createRunStream(targetUrl));
}
