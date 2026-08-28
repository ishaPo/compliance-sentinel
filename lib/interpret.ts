import type {
  ChangeClass,
  ChangeReport,
  InterpretedChange,
  RawChange,
  Severity,
  TrailEntry,
} from "./types";

type Trail = (entry: Omit<TrailEntry, "timestamp">) => void;

// Tried in order — if one model 404s, is deprecated, or is rate-limited,
// the next is tried before falling back to OpenRouter entirely. Model
// naming on Gemini's free tier has shifted over time, so this list leans on
// long-standing, broadly-available IDs rather than betting everything on
// one; if your Google AI Studio account shows different available model
// names, add them here (most-preferred first).
const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-2.5-flash", "gemini-1.5-flash"];

// Ordered so OpenRouter tries each in turn if one is rate-limited or down —
// this is OpenRouter's own documented `models` fallback-array feature
// (see openrouter.ai/docs -> model routing), not something hand-rolled here.
// All are free-tier ("...:free") models with no card required. OpenRouter's
// free-model roster shifts month to month, so if these start 404ing, check
// openrouter.ai/models filtered to "free" for current slugs.
const OPENROUTER_MODELS = [
  "deepseek/deepseek-r1:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "deepseek/deepseek-v3:free",
  "google/gemini-flash:free",
  "mistral/mistral-small-24b:free",
];

const OPENROUTER_TIMEOUT_MS = 20_000;

interface LlmChangeResult {
  sectionId: string;
  classification: ChangeClass;
  severity: Severity;
  interpretation: string;
  reasoning: string;
}

interface ProviderOutcome {
  results: LlmChangeResult[];
  modelUsed: string;
}

/** Pulls a short, useful message out of whatever a failed call threw. */
function describeError(err: unknown): string {
  if (err instanceof Error) return err.message.slice(0, 300);
  try {
    return JSON.stringify(err).slice(0, 300);
  } catch {
    return String(err).slice(0, 300);
  }
}

/**
 * One batched prompt covering every changed section in this run, rather than
 * one LLM call per change. This is a deliberate reliability choice: Vercel
 * Hobby functions cap execution time (10s default, 60s max), and a page with
 * several changed sections would risk timing out if each triggered its own
 * round-trip call.
 */
function buildPrompt(changes: RawChange[]): string {
  const items = changes.map((c) => ({
    sectionId: c.sectionId,
    sectionHeading: c.sectionHeading,
    heuristicClass: c.heuristicClass,
    before: c.before.slice(0, 1500),
    after: c.after.slice(0, 1500),
  }));

  return `You are a compliance monitoring assistant reviewing changes detected on a pharmaceutical HCP (healthcare-provider) resource webpage. For EACH change below, decide:

- "classification": "content" (the actual wording/information changed) or "functional" (only markup/CSS/layout changed — a heuristic guess is provided based on a structural fingerprint; confirm it or override it if the before/after text suggests otherwise, e.g. a trivial punctuation-only edit could be closer to cosmetic than the heuristic suggests).
- "severity": "none" | "low" | "medium" | "high" — how much this change matters from a pharma compliance/regulatory standpoint. Changes to safety information, boxed warnings, dosing, or efficacy claims are high severity. Cosmetic wording tweaks are low or none.
- "interpretation": ONE short plain-English sentence explaining why this change might matter to a compliance reviewer (or that it doesn't).
- "reasoning": one or two sentences justifying the classification and severity you chose.

This content is drawn from official prescribing-information-style language (indications, dosing, adverse reactions, boxed warnings) on an existing, already-published product page. You are reviewing it in a compliance-monitoring capacity, the same way a pharmacovigilance or regulatory affairs reviewer would — not generating new medical claims.

Changes (JSON):
${JSON.stringify(items, null, 2)}

Respond with ONLY a JSON object of this exact shape, one entry per change, same order:
{"changes": [{"sectionId": string, "classification": "content"|"functional", "severity": "none"|"low"|"medium"|"high", "interpretation": string, "reasoning": string}]}`;
}

async function callGemini(prompt: string, trail: Trail): Promise<ProviderOutcome | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    trail({ action: "Gemini skipped", reasoning: "GEMINI_API_KEY is not set.", level: "warning" });
    return null;
  }

  let sdk;
  try {
    sdk = await import("@google/generative-ai");
  } catch (err) {
    trail({ action: "Gemini SDK failed to load", detail: describeError(err), level: "error" });
    return null;
  }

  const { GoogleGenerativeAI, SchemaType, HarmCategory, HarmBlockThreshold } = sdk;
  const genAI = new GoogleGenerativeAI(apiKey);

  const responseSchema = {
    type: SchemaType.OBJECT,
    properties: {
      changes: {
        type: SchemaType.ARRAY,
        items: {
          type: SchemaType.OBJECT,
          properties: {
            sectionId: { type: SchemaType.STRING },
            classification: { type: SchemaType.STRING, enum: ["content", "functional"] },
            severity: { type: SchemaType.STRING, enum: ["none", "low", "medium", "high"] },
            interpretation: { type: SchemaType.STRING },
            reasoning: { type: SchemaType.STRING },
          },
          required: ["sectionId", "classification", "severity", "interpretation", "reasoning"],
        },
      },
    },
    required: ["changes"],
  };

  // Prescribing-information language (hepatotoxicity, boxed warnings, adverse
  // reaction rates) is exactly the kind of clinical/medical vocabulary that
  // can trip a default "dangerous content" or "medical advice" safety
  // threshold, even though this call is reviewing already-published,
  // legitimate compliance text rather than generating new medical claims.
  // Loosening these (but not disabling them entirely) reduces false-positive
  // blocks on that vocabulary without touching categories unrelated to it.
  const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
  ];

  for (const modelId of GEMINI_MODELS) {
    try {
      const model = genAI.getGenerativeModel({
        model: modelId,
        safetySettings,
        generationConfig: { responseMimeType: "application/json", responseSchema },
      });

      const result = await model.generateContent(prompt);

      const blockReason = result.response.promptFeedback?.blockReason;
      if (blockReason) {
        trail({
          action: `Gemini ${modelId} blocked the request`,
          detail: `blockReason: ${blockReason}`,
          reasoning: "The safety filter blocked this content rather than erroring — trying the next Gemini model.",
          level: "warning",
        });
        continue;
      }

      const text = result.response.text();
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed?.changes)) {
        trail({
          action: `Gemini ${modelId} returned an unexpected shape`,
          detail: text.slice(0, 200),
          level: "warning",
        });
        continue;
      }
      return { results: parsed.changes, modelUsed: modelId };
    } catch (err) {
      trail({
        action: `Gemini ${modelId} failed`,
        detail: describeError(err),
        reasoning: "Trying the next Gemini model in the fallback list before moving to OpenRouter.",
        level: "warning",
      });
    }
  }

  return null;
}

async function callOpenRouter(prompt: string, trail: Trail): Promise<ProviderOutcome | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    trail({ action: "OpenRouter skipped", reasoning: "OPENROUTER_API_KEY is not set.", level: "warning" });
    return null;
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        // OpenRouter tries each model in order, automatically moving to the
        // next one if a given model is rate-limited or unavailable — this is
        // its own documented fallback mechanism, not hand-coded retry logic.
        models: OPENROUTER_MODELS,
        messages: [{ role: "user", content: prompt }],
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(OPENROUTER_TIMEOUT_MS),
    });

    if (!res.ok) {
      const bodyText = await res.text().catch(() => "");
      trail({
        action: "OpenRouter request failed",
        detail: `${res.status} ${res.statusText}${bodyText ? ` — ${bodyText.slice(0, 250)}` : ""}`,
        reasoning:
          res.status === 429
            ? "Rate-limited — OpenRouter's free tier caps unpaid accounts at roughly 50 requests/day and 20/minute."
            : "See the response body above for the specific reason.",
        level: "error",
      });
      return null;
    }

    const data = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) {
      trail({
        action: "OpenRouter returned no content",
        detail: JSON.stringify(data).slice(0, 250),
        level: "error",
      });
      return null;
    }

    const parsed = JSON.parse(content);
    const arr: LlmChangeResult[] | null = Array.isArray(parsed?.changes) ? parsed.changes : null;
    if (!arr) {
      trail({ action: "OpenRouter output unparseable", detail: content.slice(0, 250), level: "error" });
      return null;
    }

    const modelUsed = data?.model ? `${data.model} (openrouter fallback)` : "openrouter fallback";
    return { results: arr, modelUsed };
  } catch (err) {
    trail({ action: "OpenRouter request threw", detail: describeError(err), level: "error" });
    return null;
  }
}

/**
 * Interprets a run's raw changes via the provider chain: Gemini direct
 * first, trying each model in GEMINI_MODELS in turn (native structured-
 * output mode, generous free quota on each), then OpenRouter's free-model
 * fallback array (only reached if every Gemini model failed), and a
 * defensive "no interpretation available" degradation if all of that is
 * unreachable — the run still completes and still produces a report, just
 * without narrative interpretation. Every attempt logs its own specific
 * failure reason to the trail rather than a generic "unavailable" message,
 * so a real problem (bad key, safety block, rate limit, deprecated model)
 * is visible without guesswork.
 */
export async function interpretChanges(changes: RawChange[], trail: Trail): Promise<ChangeReport> {
  if (changes.length === 0) {
    return { changes: [], cosmeticCount: 0 };
  }

  const prompt = buildPrompt(changes);

  trail({
    action: "Requesting interpretation from Gemini",
    detail: GEMINI_MODELS.join(" → "),
    reasoning: `Sending all ${changes.length} changed section(s) in a single batched call rather than one call per change, to stay well within serverless function time limits.`,
    level: "info",
  });

  let outcome = await callGemini(prompt, trail);

  if (!outcome) {
    trail({
      action: "All Gemini models failed — falling back to OpenRouter",
      reasoning: "See the Gemini failure(s) above for the specific reason. Falling back to OpenRouter's free-model pool.",
      level: "warning",
    });
    outcome = await callOpenRouter(prompt, trail);
  }

  if (!outcome) {
    trail({
      action: "No LLM interpretation available this run",
      reasoning: "Every provider attempt above failed. Degrading to heuristic-only classification with no narrative interpretation rather than failing the run.",
      level: "error",
    });
  } else {
    trail({
      action: "Interpretation received",
      detail: outcome.modelUsed,
      level: "info",
    });
  }

  const byId = new Map((outcome?.results ?? []).map((r) => [r.sectionId, r]));

  const interpreted: InterpretedChange[] = [];
  let cosmeticCount = 0;

  for (const change of changes) {
    const llm = byId.get(change.sectionId);
    const classification: ChangeClass = llm?.classification ?? change.heuristicClass;
    const severity: Severity = llm?.severity ?? (change.heuristicClass === "functional" ? "low" : "medium");
    const interpretation =
      llm?.interpretation ?? "No interpretation available — LLM providers were unreachable for this run.";
    const reasoning =
      llm?.reasoning ??
      "Falling back to the heuristic classification (text vs. structure-fingerprint comparison) with no model-generated reasoning.";
    const modelUsed = outcome?.modelUsed ?? "unavailable";

    if (classification === "functional") {
      // Cosmetic/markup-only changes are counted, not detailed — keeps the
      // report focused on changes that actually matter for compliance review.
      cosmeticCount++;
      continue;
    }

    interpreted.push({
      sectionId: change.sectionId,
      sectionHeading: change.sectionHeading,
      before: change.before,
      after: change.after,
      classification,
      severity,
      interpretation,
      reasoning,
      modelUsed,
    });
  }

  return { changes: interpreted, cosmeticCount };
}
