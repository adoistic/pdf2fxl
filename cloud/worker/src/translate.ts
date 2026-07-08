import type { Env } from "./types";
import { placeHold, releaseHold } from "./ledger";
import {
  createTranslation,
  failTranslation,
  transitionTranslation,
  type Translation,
} from "./translations";

// The translation model key: its own secret when set, else the same provider
// account the emphasis add-on uses. Provider-neutral by name (white-labeled).
export function translateKey(env: Env): string | undefined {
  return env.TRANSLATE_API_KEY || env.ENRICH_API_KEY || undefined;
}

export interface TranslateConfig {
  available: boolean;
  model: string;
  blockWords: number;
  blockMcr: number;
  maxWords: number;
}

// Single source of truth for the translation add-on's runtime state. Available
// only when a provider key is configured AND the model id and pricing rows are
// sane. Until then the option is invisible (/api/me carries no translate
// object) and every /api/translate route answers 404.
export async function translateConfig(env: Env): Promise<TranslateConfig> {
  const { results } = await env.DB
    .prepare(
      `SELECT key, value FROM config WHERE key IN
       ('translate_model', 'translate_block_words', 'translate_block_mcr', 'translate_max_words')`
    )
    .all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const model = (map.get("translate_model") ?? "").trim();
  const blockWords = Number(map.get("translate_block_words") ?? "0");
  const blockMcr = Number(map.get("translate_block_mcr") ?? "0");
  const maxWords = Number(map.get("translate_max_words") ?? "0");
  const available =
    Boolean(translateKey(env)) &&
    model !== "" &&
    Number.isSafeInteger(blockWords) && blockWords > 0 &&
    Number.isSafeInteger(blockMcr) && blockMcr > 0 &&
    Number.isSafeInteger(maxWords) && maxWords > 0;
  return { available, model, blockWords, blockMcr, maxWords };
}

// 500 credits per 350 words, prorated per word and rounded half-up to two
// decimal places of a credit (a credit is 1000 mcr, so 2dp = 10 mcr steps).
// 355 words -> 355 * 500000 / 350 = 507142.857 -> 507140 mcr = 507.14 credits.
export function priceWordsMcr(words: number, blockWords: number, blockMcr: number): number {
  return Math.round((words * blockMcr) / blockWords / 10) * 10;
}

// A translation source, already resolved: pasted text or a finished book's
// stored document structure.
export type WordCountSource =
  | { kind: "text"; text: string }
  | { kind: "doc"; docJson: unknown };

// The engine's canonical word count (injected so tests never need a container).
export type EngineWordCount = (src: WordCountSource) => Promise<number>;

export type QuoteResult = {
  words: number;
  credits: number;
  maxWords: number;
  tooLong: boolean;
};

export async function quoteTranslation(
  cfg: TranslateConfig,
  count: EngineWordCount,
  source: WordCountSource
): Promise<QuoteResult> {
  const words = await count(source);
  return {
    words,
    credits: priceWordsMcr(words, cfg.blockWords, cfg.blockMcr) / 1000,
    maxWords: cfg.maxWords,
    tooLong: words > cfg.maxWords,
  };
}

export function capMessage(words: number, maxWords: number): string {
  return (
    `sorry, that is not possible right now: this text is ${words.toLocaleString("en")} words ` +
    `and translations are capped at ${maxWords.toLocaleString("en")} words for now`
  );
}

export type SubmitResult =
  | { ok: true; translation: Translation }
  | { ok: false; status: 400 | 402 | 409 | 500; error: string };

// Create, price, hold, and promote one translation to 'processing'. The caller
// enqueues it on success. Word count comes from the injected engine count so
// what is billed is exactly what the translator will see.
export async function submitTranslation(
  db: D1Database,
  store: R2Bucket,
  count: EngineWordCount,
  cfg: TranslateConfig,
  opts: {
    userId: number;
    source: WordCountSource;
    jobId: string | null;
    title: string | null;
    targetLanguage: string;
  }
): Promise<SubmitResult> {
  let words: number;
  try {
    words = await count(opts.source);
  } catch {
    return { ok: false, status: 500, error: "we could not read this text" };
  }
  if (words < 1) return { ok: false, status: 400, error: "there is nothing to translate" };
  if (words > cfg.maxWords) {
    return { ok: false, status: 400, error: capMessage(words, cfg.maxWords) };
  }
  const chargedMcr = priceWordsMcr(words, cfg.blockWords, cfg.blockMcr);
  if (!Number.isSafeInteger(chargedMcr) || chargedMcr <= 0) {
    return {
      ok: false, status: 500,
      error: "something went wrong on our side, please try again later",
    };
  }

  // The source is materialized to R2 so the queue consumer is self-contained
  // (and the source/output pair is kept together, like the OCR artifacts).
  const id = crypto.randomUUID();
  const sourceKey = `translations/${id}/source.${opts.source.kind === "text" ? "md" : "json"}`;
  const sourceBody =
    opts.source.kind === "text" ? opts.source.text : JSON.stringify(opts.source.docJson);
  await store.put(sourceKey, sourceBody, {
    httpMetadata: {
      contentType: opts.source.kind === "text" ? "text/markdown" : "application/json",
    },
  });

  const row = await createTranslation(db, {
    id, userId: opts.userId, kind: opts.source.kind === "text" ? "text" : "book",
    jobId: opts.jobId, targetLanguage: opts.targetLanguage, title: opts.title,
    wordCount: words, blockWords: cfg.blockWords, blockMcr: cfg.blockMcr,
    chargedMcr, r2SourceKey: sourceKey,
  });

  const hold = await placeHold(db, { userId: opts.userId, jobId: id, amountMcr: chargedMcr });
  if (!hold.ok) {
    await failTranslation(
      db, id, "received",
      "not enough credits for this translation", `needed ${chargedMcr} mcr`
    );
    return { ok: false, status: 402, error: "not enough credits for this translation" };
  }
  const promoted = await transitionTranslation(db, id, "received", "processing", {
    hold_id: hold.holdId,
  });
  if (!promoted) {
    await releaseHold(db, hold.holdId);
    return { ok: false, status: 409, error: "this translation already started" };
  }
  return {
    ok: true,
    translation: { ...row, status: "processing", holdId: hold.holdId },
  };
}
