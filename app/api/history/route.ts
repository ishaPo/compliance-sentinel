import { getCheckLog, getVersions, isUsingRealStorage } from "@/lib/storage";
import { canonicalizeUrl } from "@/lib/url";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badRequest(message: string): Response {
    return new Response(JSON.stringify({ error: message }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
    });
}

/**
 * Returns the version history and check log for a URL, newest first - powers
 * the secondary version-timeline tab in the UI. Kept separate from /api/run
 * so the frontend can refresh history independently of triggering a new run
 * (e.g. on initial page load, before the user has run anything this session).
 *
 * Uses the same canonicalizeUrl as /api/run - otherwise a URL that differs
 * only by a fragment (or other client-side-only noise) could look up a
 * different storage key than the one a run actually saved under.
 */
export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const raw = searchParams.get("url")?.trim();
    if (!raw) return badRequest("Missing required query parameter: url");
    const targetUrl = canonicalizeUrl(raw);

  const [versions, checkLog, usingRealStorage] = await Promise.all([
        getVersions(targetUrl),
        getCheckLog(targetUrl),
        isUsingRealStorage(),
      ]);

  return Response.json({
        url: targetUrl,
        versions: [...versions].reverse(),
        checkLog: [...checkLog].reverse(),
        usingRealStorage,
  });
}
