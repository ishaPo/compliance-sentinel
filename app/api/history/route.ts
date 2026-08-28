import { getCheckLog, getVersions, isUsingRealStorage } from "@/lib/storage";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Returns the version history and check log for a URL, newest first — powers
 * the secondary version-timeline tab in the UI. Kept separate from /api/run
 * so the frontend can refresh history independently of triggering a new run
 * (e.g. on initial page load, before the user has run anything this session).
 */
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get("url")?.trim();
  if (!targetUrl) return badRequest("Missing required query parameter: url");

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
