# Compliance Sentinel

An autonomous agent that monitors a pharmaceutical HCP (healthcare-provider) web page, detects what changed since the last check, and reasons about why each change might matter for compliance — not just that a page's checksum changed.

**Live demo:** _add your deployed Vercel URL here_
**Target page used in the demo:** https://corvantixtargetsite.vercel.app/ (a fictional pharma product page, [source](https://github.com/) — built specifically for this exercise; see "The target page" below)

Built for the Indegene Associate Manager, Product Management (Applied AI) take-home assignment.

## What it does

1. You give it a URL.
2. It fetches the page, extracts its content section by section (by heading structure, not raw HTML), and compares that against the last snapshot it saved for that URL.
3. If nothing meaningful changed, it says so and moves on — nothing new is saved.
4. If something changed, it classifies each change as **content** (the wording/information changed) or **functional** (only markup/CSS changed, text is identical), asks an LLM to assess severity and explain in one line why a compliance reviewer should care, and saves a new version.
5. Every step — fetches, retries, redirects, classifications, provider fallbacks, save/skip decisions — is streamed to the UI in real time and logged with its reasoning.

The first run for any URL has nothing to compare against, so it's saved as the baseline. Every run after that produces a real diff.

## Why this use case

Indegene's content operations and MLR review work involves keeping a large number of client-facing pharma pages compliant as they're edited over time. A page's boxed warning, dosing, or efficacy claims changing is a very different event from a copay phone number changing font size — an agent that can tell the two apart, explain the difference, and flag severity is directly useful to that workflow, not just a generic diff checker.

## Architecture

```
┌──────────┐   SSE    ┌──────────────┐
│  Browser │◄─────────┤ /api/run     │
│  (React) │  GET     │ (streams a   │
└────┬─────┘          │  RunEvent    │
     │  GET            │  per step)   │
     ▼                └──────┬───────┘
┌──────────┐                 │
│/api/history│                ▼
└────┬───────┘         extract → diff → interpret → save
     │                        │            │           │
     ▼                        ▼            ▼           ▼
┌─────────────────────────────────────────────────────────┐
│                        Vercel KV                          │
│   versions:<urlHash>  →  VersionEntry[]  (meaningful only)│
│   checklog:<urlHash>  →  CheckLogEntry[] (every run)      │
└─────────────────────────────────────────────────────────┘
```

**Stack:** Next.js 15 (App Router), TypeScript, Cheerio for HTML parsing, Vercel KV for persistence, Gemini + OpenRouter for LLM reasoning. One deployable app — no separate backend.

### Data model

Two structures are kept per monitored URL, keyed by a hash of the URL:

- **Version history** (`lib/storage.ts`) — only saved when a run finds a *meaningful* change (or it's the first run, saved as the baseline). Each version is a full snapshot of every section plus the generated change report. Capped at 50 versions per URL.
- **Check log** — every run, regardless of outcome (`baseline_created` / `no_change` / `change_detected` / `error`), so "the agent ran and found nothing" is itself visible and auditable, not silently dropped. Capped at 200 entries per URL.

This is why storage had to be server-side (Vercel KV) rather than browser `localStorage`: the whole point of a public submission is that someone else can open the live URL and run a real check against real, shared history — not just replay whatever happened to be in the browser that built it. Locally, before you've provisioned KV, both structures fall back to an in-memory store scoped to the Node process (see `.env.example`) so `npm run dev` works immediately — but that fallback does **not** persist across server restarts or across separate serverless invocations, which is exactly why it's a fallback and not the real design.

### The extraction → diff → interpret pipeline

- **`lib/extract.ts`** fetches the page (10s timeout, up to 3 attempts with backoff for timeouts/5xx/network-level failures — a 4xx fails fast since retrying won't fix a page that doesn't exist), follows redirects, and splits the body into sections along `h1`/`h2`/`h3` boundaries. Each section gets a normalized text string *and* a `structureFingerprint` — a coarse signature of the tag names and CSS classes inside that section, text stripped out entirely.
- **`lib/diff.ts`** compares the previous snapshot to the new one, section by section. If a section's text changed, that's a **content** change. If the text is identical but the fingerprint changed, that's a **functional** change — a styling/markup edit that pure-text extraction would otherwise be structurally unable to see at all. Sections that appeared or disappeared entirely are handled as their own cases.
- **`lib/interpret.ts`** sends every changed section in **one batched LLM call** (not one call per change) — a deliberate reliability choice, since Vercel's Hobby-tier functions cap execution time and a page with several changes could otherwise risk timing out. It asks the model to confirm or override the heuristic classification, assign a severity (`none`/`low`/`medium`/`high`), and write a one-line interpretation plus its reasoning. The interpretation is required to open with one of eight named compliance categories (safety information, boxed warning, dosing/administration, efficacy claim, testimonial/case-study substantiation, promotional fair balance, HCP-access boundary, or "no compliance concern") — an earlier version of the prompt let the model describe *what* changed without saying *why it matters*, which read as accurate but unhelpful to an actual reviewer deciding whether to act on it.
- Functional/cosmetic changes are counted but excluded from the detailed report — the report stays focused on what a reviewer actually needs to read, and the trail/history still show that they happened.

### LLM provider chain

1. **Gemini**, called directly using its native structured-output mode (a JSON schema, not prompt-and-hope), trying up to five current free-tier models in order (`gemini-2.5-flash-lite` → `gemini-2.5-flash` → `gemini-3.1-flash-lite` → `gemini-3.6-flash` → `gemini-3.5-flash`) before giving up on Gemini entirely. This list had to be updated once already — Google retired `gemini-2.0-flash` and `gemini-1.5-flash` mid-project, and the trail's per-model error logging (see below) is what surfaced the exact 404s that made the fix obvious rather than a guess.
2. If every Gemini model fails, is rate-limited, or the key is missing — **OpenRouter**, called with an ordered `models` array of free models (capped at exactly 3 — OpenRouter's chat-completions endpoint rejects a longer array with a 400, which was itself a real bug caught via the trail before this cap was added). OpenRouter automatically tries the next model in the list if one is unavailable; this is its own documented fallback mechanism, not hand-rolled retry logic.
3. If both are unreachable, the run still completes: sections keep their heuristic classification, severity defaults conservatively, and the interpretation reads "No interpretation available" rather than the run failing outright. Every step of this chain is visible in the agent trail, including which model actually answered and, on failure, the exact provider error rather than a generic message.

### The agentic decision points

These are the places the agent makes a judgment call rather than mechanically executing a fixed script — the evidence that it's doing more than "fetch one page and stop":

| Decision | Where |
|---|---|
| Retry with backoff vs. fail fast | `extract.ts` — retries timeouts/5xx/network errors, fails immediately on 4xx |
| Follow a redirect vs. flag it | `extract.ts` — same-domain redirects are followed quietly; cross-domain redirects are followed *and* flagged as a warning, since a hijacked or migrated compliance page is itself a signal worth a human's attention |
| Content vs. functional classification | `diff.ts` heuristic, then confirmed/overridden by the LLM in `interpret.ts` |
| Severity assignment with self-justification | `interpret.ts` — the model states *why*, not just *what* |
| Save a new version vs. skip it | `app/api/run/route.ts` — a run that finds only cosmetic changes doesn't version, to avoid inflating history with noise |
| Provider fallback on failure | `interpret.ts` — Gemini → OpenRouter → graceful degradation |

### UI

Three panels stay visible together while a run is in progress — this was a deliberate choice, since the assignment asks for all three and burying any of them behind a tab would undercut that:

- **Live status** — a real-time feed of what the agent is doing right now (`EventSource` over Server-Sent Events from `/api/run`).
- **Change report** — the structured output: one card per meaningful change, its section, a prominent one-line interpretation, before/after text, a severity chip, and the fuller reasoning + model attribution behind an expand toggle (kept collapsed by default so the primary read stays scannable).
- **Agent trail** — every action logged with its reasoning, color-coded by level (info/decision/warning/error).

**Version history** (every saved version, plus the full check log including no-op runs) lives in a secondary tab — it's genuinely useful for understanding the persistence model, but it isn't one of the three things the assignment asks for, so it doesn't compete for space with the panels that are.

## Running locally

```bash
npm install
cp .env.example .env.local   # fill in GEMINI_API_KEY at minimum
npm run dev
```

Open http://localhost:3000. Without `KV_REST_API_URL`/`KV_REST_API_TOKEN` set, storage falls back to an in-memory store for that dev session — good enough to try the pipeline end to end, but it resets whenever the dev server restarts and (by design) isn't shared with any other environment.

## Deploying

1. Push this repo to GitHub, import it into Vercel (or drag-and-drop deploy).
2. In the Vercel dashboard: **Storage → Create Database**, then under **Marketplace Database Providers** choose **Upstash**, and provision a **Redis** database — this is what "Vercel KV" now is; the standalone KV product was folded into Upstash. Link it to this project. Vercel injects the connection env vars automatically — nothing to copy by hand. (Depending on the integration path, you may see `KV_REST_API_URL`/`KV_REST_API_TOKEN` or `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` — `lib/storage.ts` checks for both, so either works.)
3. **Settings → Environment Variables**: add `GEMINI_API_KEY` (free at https://aistudio.google.com) and, optionally, `OPENROUTER_API_KEY` (free at https://openrouter.ai/keys) for the fallback path.
4. Redeploy after adding the env vars/store so the running functions pick them up.

## Known limitations

- **Section boundaries assume the page's headings and their content are structural siblings** (`extract.ts` walks `nextUntil` between one heading and the next). This matches the target page's actual markup and most simple content pages, but wouldn't generalize to a page where semantically distinct sections are nested in unrelated parts of the DOM tree. A more robust version would do a full tree-order traversal instead of a sibling walk.
- **Fixed in testing: duplicate heading text collided into one section id.** `indegene.com`'s "Life sciences leaders trust us" section renders both an H2 eyebrow and an H3 heading with the identical text immediately above the actual case-study content. Both slugified to the same id, so the two DOM nodes' sections (one empty, one with the real text) were pushed under one key — and because the id-keyed lookup used in `diffSections` collapses duplicates, the same "content removed" diff kept re-triggering on every run even with zero real page changes. Fixed by suffixing repeated slugs with an occurrence count (`life-sciences-leaders-trust-us`, `life-sciences-leaders-trust-us-2`, ...) so each physical heading gets a stable, distinct id. One transitional re-detection is expected on the first run after this fix ships, since prior saved versions were stored under the old collapsed id.
- **`structureFingerprint` is a coarse proxy, not a full CSS diff** — it catches "the tags/classes in this section changed," which is enough to distinguish a markup/styling edit from a wording edit, but it won't catch a pure inline-style or external-stylesheet change that touches no tag or class.
- **Free-tier LLM quotas are limited** (Gemini: ~1,500 requests/day; OpenRouter free models: much lower, and shared across everyone using that model). The provider chain degrades gracefully rather than failing when quota is exhausted, but a busy demo day could still exhaust it — which is exactly the scenario the fallback chain and the "no interpretation available" state exist to handle visibly rather than silently.
- **SSE and proxying**: Server-Sent Events over `fetch`/`Response` streaming is a well-documented Vercel pattern, but any intermediary proxy that buffers responses could delay the "live" feel of the status feed. The route sets `X-Accel-Buffering: no` as a hint against this.

## Repo structure

```
app/
  page.tsx              — the UI (client component)
  layout.tsx, globals.css
  api/run/route.ts       — streams the fetch → extract → diff → interpret → save pipeline via SSE
  api/history/route.ts   — returns version history + check log for a URL
components/               — StatusFeed, AgentTrailView, ChangeReportView, VersionHistoryView, chips/badges
lib/
  extract.ts             — fetch with retry/backoff, redirect handling, section + fingerprint extraction
  diff.ts                — section-by-section content vs. functional classification
  interpret.ts           — Gemini → OpenRouter provider chain, batched structured-output call
  storage.ts             — Vercel KV wrapper with an in-memory dev fallback
  types.ts               — shared types every module builds against
  format.ts               — small date/time formatting helpers
```

## Built with

Architecture, code, and this README were built with Claude, working from a locked spec developed collaboratively over the course of this assignment.
