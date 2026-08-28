import * as cheerio from "cheerio";
import type { ExtractResult, ExtractedSection, TrailEntry } from "./types";

const FETCH_TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3; // 1 initial + 2 retries
const BACKOFF_MS = [500, 1500];

export class ExtractError extends Error {
  /** Whether this specific failure is worth retrying (e.g. a 5xx) vs. a definitive no (e.g. a 404). */
  retryable: boolean;

  constructor(message: string, options?: { retryable?: boolean }) {
    super(message);
    this.name = "ExtractError";
    this.retryable = options?.retryable ?? false;
  }
}

type Trail = (entry: Omit<TrailEntry, "timestamp">) => void;

function slugify(text: string): string {
  return (
    text
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "") || "section"
  );
}

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * Builds a coarse structural signature for a set of nodes: tag name + sorted
 * class list for each element in the range (including nested descendants),
 * text content stripped out entirely. Two runs of the same section produce
 * the same fingerprint iff the markup/CSS structure is unchanged — a pure
 * copy edit (text differs, tags/classes don't) leaves it untouched, while a
 * CSS/markup-only change (text identical, tags/classes differ) changes it.
 * This is what lets the diff engine tell "content" changes apart from
 * "functional" ones even though extraction otherwise discards all markup.
 */
function computeStructureFingerprint($: cheerio.CheerioAPI, nodes: any[]): string {
  const parts: string[] = [];
  for (const n of nodes) {
    $(n)
      .find("*")
      .addBack()
      .each((_, el) => {
        const tag = (el as any).tagName?.toLowerCase?.();
        if (!tag) return;
        const classAttr = $(el).attr("class");
        const classes = classAttr ? classAttr.split(/\s+/).filter(Boolean).sort().join(".") : "";
        parts.push(classes ? `${tag}.${classes}` : tag);
      });
  }
  return parts.join("|");
}

async function fetchWithRetry(url: string, trail: Trail): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "compliance-sentinel-agent/0.1 (+change-detection prototype)",
        },
      });
      clearTimeout(timeout);

      if (response.status >= 500) {
        // Server-side errors are often transient — worth retrying.
        throw new ExtractError(`Server responded ${response.status} ${response.statusText}`, { retryable: true });
      }
      if (response.status >= 400) {
        // Client errors (404, 403, ...) are a definitive "no" — fail fast, clearly, no point retrying.
        throw new ExtractError(`Target returned ${response.status} ${response.statusText}`, { retryable: false });
      }
      return response;
    } catch (err) {
      clearTimeout(timeout);
      lastError = err;
      const timedOut = err instanceof Error && err.name === "AbortError";
      // Retry on: a timeout, an explicitly-retryable ExtractError (5xx), or
      // any other thrown error — which in practice means a generic
      // network-level failure (DNS resolution, connection refused, TLS)
      // rather than the target explicitly telling us no. Those are exactly
      // the kind of transient failure retries are meant to smooth over.
      const retryable = timedOut || !(err instanceof ExtractError) || err.retryable;
      const reason = timedOut ? "timed out" : err instanceof Error ? err.message : "an unknown error occurred";

      if (attempt < MAX_ATTEMPTS && retryable) {
        trail({
          action: `Retrying fetch (attempt ${attempt + 1}/${MAX_ATTEMPTS})`,
          detail: url,
          reasoning: `Previous attempt ${reason} — retrying with backoff before giving up.`,
          level: "decision",
        });
        await new Promise((r) => setTimeout(r, BACKOFF_MS[attempt - 1] ?? 1500));
        continue;
      }

      if (err instanceof ExtractError) throw err;
      throw new ExtractError(
        `Could not reach ${url} after ${attempt} attempt(s) — ${reason}. The site may be down, blocking automated requests, or unreachable from this network.`
      );
    }
  }

  throw lastError instanceof Error ? lastError : new ExtractError("Fetch failed after retries");
}

/**
 * Fetches a page, follows redirects, and extracts its content into sections
 * keyed by heading structure — not raw HTML. Section boundaries are h1–h3
 * headings; everything between one heading and the next (of equal or higher
 * level) belongs to that section.
 */
export async function extractPage(targetUrl: string, trail: Trail): Promise<ExtractResult> {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    throw new ExtractError(`"${targetUrl}" isn't a valid URL — include the protocol, e.g. https://…`);
  }

  trail({ action: "Fetching target URL", detail: parsed.toString(), level: "info" });

  const response = await fetchWithRetry(parsed.toString(), trail);

  const finalUrl = response.url || parsed.toString();
  const redirected = response.redirected || finalUrl !== parsed.toString();
  let crossDomainRedirect = false;
  if (redirected) {
    try {
      crossDomainRedirect = new URL(finalUrl).hostname !== parsed.hostname;
    } catch {
      crossDomainRedirect = false;
    }
    trail({
      action: crossDomainRedirect ? "Followed redirect to a different domain" : "Followed redirect",
      detail: finalUrl,
      reasoning: crossDomainRedirect
        ? "Target redirected off its original domain — following it, but flagging this as worth a human look. A hijacked or migrated compliance page is itself a signal."
        : "Same-domain redirect (e.g. trailing slash or protocol upgrade) — followed without flagging.",
      level: crossDomainRedirect ? "warning" : "info",
    });
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("text/html")) {
    throw new ExtractError(
      `Target responded with "${contentType || "unknown"}" content, not HTML — this agent monitors web pages, not files or APIs.`
    );
  }

  const html = await response.text();
  const $ = cheerio.load(html);
  $("script, style, noscript, svg").remove();

  trail({
    action: "Extracting content by section",
    detail: `${html.length.toLocaleString()} characters of HTML`,
    level: "info",
  });

  const sections: ExtractedSection[] = [];
  const headings = $("h1, h2, h3").toArray();

  if (headings.length === 0) {
    // Fallback: no heading structure to key off — treat the whole body as one section.
    const bodyEl = $("body")[0];
    const text = normalizeWhitespace($("body").text());
    const fingerprint = bodyEl ? computeStructureFingerprint($, [bodyEl]) : "";
    sections.push({ id: "page", heading: "Full page", text, structureFingerprint: fingerprint });
    trail({
      action: "No heading structure found",
      reasoning: "Falling back to treating the whole page as a single section — coarser, but still meaningful content rather than raw markup.",
      level: "decision",
    });
  } else {
    const stopTags = new Set(["H1", "H2", "H3"]);
    // Tracks how many times each slug has been seen so far in this pass, so
    // two headings with identical text (common on marketing pages that
    // render a short "eyebrow" heading directly above the real heading with
    // the same words, or a duplicate mobile/desktop layout) get distinct
    // ids instead of colliding. Without this, both sections would be pushed
    // under the same id, later collapsed to a single entry by the id-keyed
    // Maps in diffSections, and compared against the wrong counterpart on
    // every single run — surfacing the same "change" forever even when
    // nothing on the page actually changes. See "Known limitations" in
    // README.md for how this was diagnosed.
    const seenSlugs = new Map<string, number>();

    headings.forEach((el, i) => {
      const heading = normalizeWhitespace($(el).text());
      const baseId = slugify(heading) || `section-${i}`;
      const occurrence = seenSlugs.get(baseId) ?? 0;
      seenSlugs.set(baseId, occurrence + 1);
      const id = occurrence === 0 ? baseId : `${baseId}-${occurrence + 1}`;

      // Find the next heading anywhere after this one, to use as a stop boundary.
      const nextHeading = $(el)
        .nextAll()
        .filter((_, n) => stopTags.has((n as any).tagName?.toUpperCase?.() ?? ""))
        .first();
      const stopEl = nextHeading.length ? nextHeading[0] : undefined;

      const siblingNodes = $(el).nextUntil(stopEl as any).toArray();

      const textParts: string[] = [];
      siblingNodes.forEach((n) => {
        const t = normalizeWhitespace($(n).text());
        if (t) textParts.push(t);
      });

      const text = normalizeWhitespace(textParts.join(" "));
      const fingerprint = computeStructureFingerprint($, siblingNodes);
      sections.push({ id, heading, text, structureFingerprint: fingerprint });
    });
  }

  return {
    finalUrl,
    redirected,
    crossDomainRedirect,
    sections,
    fetchedAt: new Date().toISOString(),
  };
}
