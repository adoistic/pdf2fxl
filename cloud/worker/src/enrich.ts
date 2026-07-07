import type { Env } from "./types";

// Single source of truth for the emphasis add-on's runtime state. The add-on is
// available only when BOTH an OpenRouter key is configured (a Worker secret) AND
// an OpenRouter model id is set in the config table. Until both hold, the upload
// checkbox is hidden (/api/config) and POST /api/jobs rejects enrich=1.
export async function enrichConfig(
  env: Env
): Promise<{ available: boolean; rateMcr: number; rateCredits: number; model: string }> {
  const { results } = await env.DB
    .prepare("SELECT key, value FROM config WHERE key IN ('enrich_model', 'rate_enrich_mcr')")
    .all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const model = (map.get("enrich_model") ?? "").trim();
  const rateMcr = Number(map.get("rate_enrich_mcr") ?? "0");
  const available = Boolean(env.OPENROUTER_API_KEY) && model !== "";
  return { available, rateMcr, rateCredits: rateMcr / 1000, model };
}
