import crypto from "crypto";
import type { VersionEntry, CheckLogEntry } from "./types";

// Two structures per monitored URL:
//   versions:<urlKey>   -> VersionEntry[]   (only meaningful changes, capped)
//   checklog:<urlKey>   -> CheckLogEntry[]  (every run, lightweight, capped)
//
// Backed by a Redis-compatible store in production — provisioned via
// Vercel's Marketplace (Upstash), which is what "Vercel KV" now is; Vercel
// deprecated the standalone KV product and folded it into Upstash, and
// different integration paths have injected the connection details under
// slightly different env var names over time (the original KV_REST_API_*
// naming, or Upstash's own UPSTASH_REDIS_REST_* naming). Rather than assume
// one, this checks for whichever pair is actually present. When neither is
// set (e.g. local dev before a store is provisioned), falls back to an
// in-memory Map scoped to this server process — good enough to develop and
// test the pipeline against, but it will not persist across restarts or
// across serverless function instances. That fallback is intentional: it
// keeps `npm run dev` working on day one without blocking on store setup.

const MAX_VERSIONS = 50;
const MAX_CHECKLOG = 200;

export function urlKey(url: string): string {
  return crypto.createHash("sha256").update(url.trim()).digest("hex").slice(0, 24);
}

type KvLike = { get: (k: string) => Promise<unknown>; set: (k: string, v: unknown) => Promise<unknown> };

// Next.js compiles each Route Handler file as its own bundle, even in dev —
// a plain module-scoped `let`/`const` here would end up as a SEPARATE
// instance per route file (e.g. one copy for /api/run, another for
// /api/history), so writes from one route would be invisible to the other
// even though both run in the same Node process. Pinning the cache and the
// in-memory fallback store to `globalThis` instead makes them genuinely
// process-wide singletons, which is what makes local dev (without KV
// configured) usable at all across more than one route.
declare global {
  // eslint-disable-next-line no-var
  var __complianceSentinelKv: KvLike | null | undefined;
  // eslint-disable-next-line no-var
  var __complianceSentinelMemory: Map<string, unknown> | undefined;
}

async function getKv(): Promise<KvLike | null> {
  if (globalThis.__complianceSentinelKv !== undefined) return globalThis.__complianceSentinelKv;

  // Try both naming conventions Vercel's storage integrations have used for
  // a Redis REST connection — legacy Vercel KV, and native Upstash.
  const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

  if (url && token) {
    try {
      // createClient (rather than the `kv` default export) lets us point at
      // whichever env vars we actually found, instead of the SDK silently
      // reading only KV_REST_API_URL/KV_REST_API_TOKEN itself.
      const { createClient } = await import("@vercel/kv");
      globalThis.__complianceSentinelKv = createClient({ url, token }) as unknown as KvLike;
    } catch {
      globalThis.__complianceSentinelKv = null;
    }
  } else {
    globalThis.__complianceSentinelKv = null;
  }
  return globalThis.__complianceSentinelKv;
}

function getMemory(): Map<string, unknown> {
  if (!globalThis.__complianceSentinelMemory) {
    globalThis.__complianceSentinelMemory = new Map();
  }
  return globalThis.__complianceSentinelMemory;
}

async function readKey<T>(key: string, fallback: T): Promise<T> {
  const kv = await getKv();
  if (kv) {
    const val = await kv.get(key);
    return (val as T) ?? fallback;
  }
  return (getMemory().get(key) as T) ?? fallback;
}

async function writeKey<T>(key: string, value: T): Promise<void> {
  const kv = await getKv();
  if (kv) {
    await kv.set(key, value);
  } else {
    getMemory().set(key, value);
  }
}

export async function getVersions(url: string): Promise<VersionEntry[]> {
  return readKey<VersionEntry[]>(`versions:${urlKey(url)}`, []);
}

export async function getLatestVersion(url: string): Promise<VersionEntry | null> {
  const versions = await getVersions(url);
  return versions.length ? versions[versions.length - 1] : null;
}

export async function appendVersion(url: string, entry: VersionEntry): Promise<void> {
  const versions = await getVersions(url);
  versions.push(entry);
  while (versions.length > MAX_VERSIONS) versions.shift();
  await writeKey(`versions:${urlKey(url)}`, versions);
}

export async function getCheckLog(url: string): Promise<CheckLogEntry[]> {
  return readKey<CheckLogEntry[]>(`checklog:${urlKey(url)}`, []);
}

export async function appendCheckLog(url: string, entry: CheckLogEntry): Promise<void> {
  const log = await getCheckLog(url);
  log.push(entry);
  while (log.length > MAX_CHECKLOG) log.shift();
  await writeKey(`checklog:${urlKey(url)}`, log);
}

/** True when running against real Vercel KV rather than the in-memory fallback. */
export async function isUsingRealStorage(): Promise<boolean> {
  return (await getKv()) !== null;
}
