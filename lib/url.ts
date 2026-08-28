/**
 * Canonicalizes a URL before it's used as the agent's identity for a
 * monitored target - trims whitespace and strips the fragment (#...).
 *
 * A fragment is purely client-side: a browser (and fetch) never sends it
 * to the server as part of the request, so https://site.com/#pricing and
 * https://site.com/ fetch the exact same document. Without this step,
 * those two strings would hash to different storage keys and be tracked as
 * two unrelated "targets" with separate version histories, even though
 * they're the same page.
 *
 * Used by both /api/run and /api/history so a URL always resolves to the
 * same identity no matter which route receives it - if they normalized
 * differently, a run and a later history lookup for "the same" URL could
 * silently miss each other.
 */
export function canonicalizeUrl(raw: string): string {
    const trimmed = raw.trim();
    try {
          const parsed = new URL(trimmed);
          parsed.hash = "";
          return parsed.toString();
    } catch {
          // Not a parseable URL - return the trimmed input as-is. extractPage's
      // own validation produces the real, user-facing error for this case;
      // this function's job is normalization, not validation.
      return trimmed;
    }
}
