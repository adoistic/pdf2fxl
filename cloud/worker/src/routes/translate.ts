import { Hono } from "hono";
import type { AppUser, Env } from "../types";
import {
  quoteTranslation,
  submitTranslation,
  translateConfig,
  type TranslateConfig,
  type WordCountSource,
  type EngineWordCount,
} from "../translate";
import {
  getTranslationForUser,
  listTranslationsForUser,
  type Translation,
} from "../translations";
import { safeTitle, type RenderFn } from "../download";
import { r2DirectEnabled, presignGet } from "../presign";

type Ctx = {
  Bindings: Env;
  Variables: { user: AppUser; translateCfg: TranslateConfig };
};

export const translate = new Hono<Ctx>();

// Per-user gate: the option is invisible unless the admin flipped the user's
// flag AND the add-on is configured. Everything answers 404 (never 403), so
// the feature's existence is not revealed to anyone it is not enabled for.
translate.use("*", async (c, next) => {
  const row = await c.env.DB
    .prepare("SELECT translate_enabled FROM users WHERE id = ?1")
    .bind(c.get("user").id)
    .first<{ translate_enabled: number }>();
  if (row?.translate_enabled !== 1) return c.json({ error: "not found" }, 404);
  const cfg = await translateConfig(c.env);
  if (!cfg.available) return c.json({ error: "not found" }, 404);
  c.set("translateCfg", cfg);
  await next();
});

// The canonical word count comes from the engine (one implementation of what
// a word is, shared with the translator), like /prepare does for page counts.
function engineWordCount(env: Env): EngineWordCount {
  return async (src: WordCountSource) => {
    const engine = env.OCR_ENGINE.getByName("engine");
    const body =
      src.kind === "text"
        ? { kind: "text", text: src.text }
        : { kind: "doc", doc_json: src.docJson };
    const res = await engine.fetch(
      new Request("http://engine/translate/quote", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      })
    );
    if (!res.ok) throw new Error(`engine /translate/quote ${res.status}`);
    const out = (await res.json()) as { word_count: number };
    if (!Number.isSafeInteger(out.word_count) || out.word_count < 0) {
      throw new Error(`engine returned word_count ${out.word_count}`);
    }
    return out.word_count;
  };
}

// Far above any 2,000-word text; protects the isolate from pathological pastes.
const MAX_SOURCE_CHARS = 400_000;

type Resolved =
  | { ok: true; source: WordCountSource; jobId: string | null; title: string | null }
  | { ok: false; status: 400 | 404 | 409 | 413; error: string };

// A translation source is pasted text or one of the user's finished books
// (its stored document structure, so the translated text lands back in place).
async function resolveSource(env: Env, userId: number, body: unknown): Promise<Resolved> {
  const b = (body ?? {}) as Record<string, unknown>;
  if (b.kind === "text") {
    const text = typeof b.text === "string" ? b.text : "";
    if (!text.trim()) return { ok: false, status: 400, error: "paste some text to translate" };
    if (text.length > MAX_SOURCE_CHARS) {
      return {
        ok: false, status: 413,
        error: "sorry, that is not possible right now: translations are capped at 2,000 words for now",
      };
    }
    return { ok: true, source: { kind: "text", text }, jobId: null, title: null };
  }
  if (b.kind === "book") {
    const jobId = typeof b.jobId === "string" ? b.jobId : "";
    if (!jobId) return { ok: false, status: 400, error: "choose a book to translate" };
    const row = await env.DB
      .prepare("SELECT status, title, r2_doc_key FROM jobs WHERE id = ?1 AND user_id = ?2")
      .bind(jobId, userId)
      .first<{ status: string; title: string | null; r2_doc_key: string | null }>();
    if (!row) return { ok: false, status: 404, error: "not found" };
    if (row.status !== "ready" || !row.r2_doc_key) {
      return { ok: false, status: 409, error: "this edition is not ready yet" };
    }
    const obj = await env.STORE.get(row.r2_doc_key);
    if (!obj) return { ok: false, status: 404, error: "not found" };
    return {
      ok: true,
      source: { kind: "doc", docJson: JSON.parse(await obj.text()) },
      jobId,
      title: row.title,
    };
  }
  return { ok: false, status: 400, error: "unknown source" };
}

// Any language, but a sane one: letters (any script), spaces and a few marks.
const LANGUAGE_RE = /^[\p{L}][\p{L} .()&'-]{1,59}$/u;

function publicTranslation(t: Translation) {
  return {
    id: t.id, kind: t.kind, jobId: t.jobId, targetLanguage: t.targetLanguage,
    status: t.status, title: t.title, words: t.wordCount,
    credits: t.chargedMcr == null ? null : t.chargedMcr / 1000,
    error: t.errorPublic, createdAt: t.createdAt,
  };
}

// Price a source without charging: live word count, credits needed, cap state.
translate.post("/quote", async (c) => {
  const cfg = c.get("translateCfg");
  const body = await c.req.json().catch(() => null);
  const resolved = await resolveSource(c.env, c.get("user").id, body);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);
  try {
    return c.json(await quoteTranslation(cfg, engineWordCount(c.env), resolved.source));
  } catch {
    return c.json({ error: "we could not read this text" }, 500);
  }
});

translate.post("/", async (c) => {
  const cfg = c.get("translateCfg");
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  const b = (body ?? {}) as Record<string, unknown>;

  const targetLanguage = typeof b.targetLanguage === "string" ? b.targetLanguage.trim() : "";
  if (!LANGUAGE_RE.test(targetLanguage)) {
    return c.json({ error: "choose a language to translate into" }, 400);
  }

  const resolved = await resolveSource(c.env, user.id, body);
  if (!resolved.ok) return c.json({ error: resolved.error }, resolved.status);

  const result = await submitTranslation(c.env.DB, c.env.STORE, engineWordCount(c.env), cfg, {
    userId: user.id, source: resolved.source, jobId: resolved.jobId,
    title: resolved.title, targetLanguage,
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  await c.env.OCR_QUEUE.send({ translationId: result.translation.id });
  return c.json(publicTranslation(result.translation));
});

translate.get("/", async (c) => {
  const list = await listTranslationsForUser(c.env.DB, c.get("user").id);
  return c.json({ translations: list.map(publicTranslation) });
});

translate.get("/:id", async (c) => {
  const t = await getTranslationForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!t) return c.json({ error: "not found" }, 404);
  return c.json(publicTranslation(t));
});

// The translated text itself, for inline display (small: capped at 2,000 words).
translate.get("/:id/result", async (c) => {
  const t = await getTranslationForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!t) return c.json({ error: "not found" }, 404);
  if (t.status !== "ready" || !t.r2MdKey) {
    return c.json({ error: "this translation is not ready yet" }, 409);
  }
  const obj = await c.env.STORE.get(t.r2MdKey);
  if (!obj) return c.json({ error: "not found" }, 404);
  return c.json({ ...publicTranslation(t), markdown: await obj.text() });
});

const CONTENT_TYPE: Record<string, string> = {
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown; charset=utf-8",
};

// Downloads. Markdown streams (or presign-redirects) from R2; a translated
// book also renders EPUB/Word on demand from its translated document plus the
// source edition's figures, exactly like the edition's own downloads.
translate.get("/:id/download", async (c) => {
  const t = await getTranslationForUser(c.env.DB, c.req.param("id"), c.get("user").id);
  if (!t) return c.json({ error: "not found" }, 404);
  if (t.status !== "ready") return c.json({ error: "this translation is not ready yet" }, 409);
  const format = c.req.query("format") ?? "md";
  const name = `${safeTitle(t.title)}-${safeTitle(t.targetLanguage)}`;

  if (format === "md") {
    if (!t.r2MdKey) return c.json({ error: "not found" }, 404);
    if (r2DirectEnabled(c.env)) {
      const head = await c.env.STORE.head(t.r2MdKey);
      if (!head) return c.json({ error: "not found" }, 404);
      return c.redirect(await presignGet(c.env, t.r2MdKey), 302);
    }
    const obj = await c.env.STORE.get(t.r2MdKey);
    if (!obj) return c.json({ error: "not found" }, 404);
    return new Response(await obj.text(), {
      headers: {
        "content-type": CONTENT_TYPE.md,
        "content-disposition": `attachment; filename="${name}.md"`,
      },
    });
  }

  if (format !== "epub" && format !== "docx") {
    return c.json({ error: "unknown format" }, 400);
  }
  if (t.kind !== "book" || !t.r2DocKey) {
    return c.json({ error: "this translation has no book edition" }, 409);
  }
  const docObj = await c.env.STORE.get(t.r2DocKey);
  if (!docObj) return c.json({ error: "not found" }, 404);
  const docJson = JSON.parse(await docObj.text());

  const figures: { name: string; base64: string }[] = [];
  if (t.jobId) {
    const src = await c.env.DB
      .prepare("SELECT r2_figures_prefix FROM jobs WHERE id = ?1")
      .bind(t.jobId)
      .first<{ r2_figures_prefix: string | null }>();
    if (src?.r2_figures_prefix) {
      const listed = await c.env.STORE.list({ prefix: src.r2_figures_prefix });
      for (const o of listed.objects) {
        const f = await c.env.STORE.get(o.key);
        if (!f) continue;
        figures.push({
          name: o.key.slice(src.r2_figures_prefix.length),
          base64: bytesToBase64(new Uint8Array(await f.arrayBuffer())),
        });
      }
    }
  }

  const render: RenderFn = async (doc, figs, fmt) => {
    const engine = c.env.OCR_ENGINE.getByName("engine");
    const res = await engine.fetch(
      new Request("http://engine/render", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ doc_json: doc, figures: figs, format: fmt }),
      })
    );
    if (!res.ok) throw new Error(`engine /render ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  };
  const bytes = await render(docJson, figures, format);
  return new Response(bytes as BodyInit, {
    headers: {
      "content-type": CONTENT_TYPE[format],
      "content-disposition": `attachment; filename="${name}.${format}"`,
    },
  });
});

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
