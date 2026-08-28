import type {
  ChangeClass,
  ChangeReport,
  InterpretedChange,
  RawChange,
  Severity,
  TrailEntry,
} from "./types";

type Trail = (entry: Omit<TrailEntry, "timestamp">) => void;

const GEMINI_MODEL = "gemini-2.0-flash";

// Ordered so OpenRouter tries each in turn if one is rate-limited or down —
// this is OpenRouter's own documented `models` fallback-array feature
// (see openrouter.ai/docs -> model routing), not something hand-rolled here.
// All three are free-tier models with no card required.
const OPENROUTER_MODELS = [
  "google/gemini-2.0-flash-exp:free",
  "meta-llama/llama-3.3-70b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
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

Changes (JSON):
${JSON.stringify(items, null, 2)}

Respond with ONLY a JSON object of this exact shape, one entry per change, same order:
{"changes": [{"sectionId": string, "classification": "content"|"functional", "severity": "none"|"low"|"medium"|"high", "interpretation": string, "reasoning": string}]}`;
}

async function callGemini(prompt: string): Promise<ProviderOutcome | null> {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;

  try {
    const { GoogleGenerativeAI, SchemaType } = await import("@google/generative-ai");
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: GEMINI_MODEL,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: {
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
        },
      },
    });

    const result = await model.generateContent(prompt);
    const text = result.response.text();
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed?.changes)) return null;
    return { results: parsed.changes, modelUsed: GEMINI_MODEL };
  } catch {
    return null;
  }
}

async function callOpenRouter(prompt: string): Promise<ProviderOutcome | null> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) return null;

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

    if (!res.ok) return null;

    const data = await res.json();
    const content: string | undefined = data?.choices?.[0]?.message?.content;
    if (!content) return null;

    const parsed = JSON.parse(content);
    const arr: LlmChangeResult[] | null = Array.isArray(parsed?.changes) ? parsed.changes : null;
    if (!arr) return null;

    const modelUsed = data?.model ? `${data.model} (openrouter fallback)` : "openrouter fallback";
    return { results: arr, modelUsed };
  } catch {
    return null;
  }
}

/**
 * Interprets a run's raw changes via the provider chain: Gemini direct
 * first (native structured-output mode, generous free quota), OpenRouter's
 * free-model fallback array second (only reached if Gemini is missing a
 * key, rate-limited, or errors), and a defensive "no interpretation
 * available" degradation if both are unreachable — the run still completes
 * and still produces a report, just without narrative interpretation.
 */
export async function interpretChanges(changes: RawChange[], trail: Trail): Promise<ChangeReport> {
  if (changes.length === 0) {
    return { changes: [], cosmeticCount: 0 };
  }

  const prompt = buildPrompt(changes);

  trail({
    action: "Requesting interpretation from Gemini",
    detail: GEMINI_MODEL,
    reasoning: `Sending all ${changes.length} changed section(s) in a single batched call rather than one call per change, to stay well within serverless function time limits.`,
    level: "info",
  });

  let outcome = await callGemini(prompt);

  if (!outcome) {
    trail({
      action: "Gemini unavailable — falling back to OpenRouter",
      reasoning: "Gemini produced no usable result (missing key, rate limit, or an error). Falling back to OpenRouter's free-model pool, which tries each model in its fallback list in turn.",
      level: "warning",
    });
    outcome = await callOpenRouter(prompt);
  }

  if (!outcome) {
    trail({
      action: "No LLM interpretation available this run",
      reasoning: "Both Gemini and OpenRouter were unreachable (missing keys, rate-limited, or down). Degrading to heuristic-only classification with no narrative interpretation rather than failing the run.",
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
