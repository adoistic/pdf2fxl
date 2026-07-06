import type { Env } from "./types";

// The container render call is injected so tests never need a running container.
export type RenderFn = (
  docJson: unknown,
  figures: { name: string; base64: string }[],
  format: "epub" | "docx"
) => Promise<Uint8Array>;

export type DownloadResult =
  | { ok: true; contentType: string; filename: string; body: ArrayBuffer | Uint8Array | string }
  | { ok: false; status: 400 | 404 | 409; error: string };

const CONTENT_TYPE: Record<string, string> = {
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  md: "text/markdown; charset=utf-8",
};

// A filesystem- and header-safe filename from the user's title. Never an internal
// id, never a vendor name.
export function safeTitle(title: string | null): string {
  const base = (title ?? "").normalize("NFKD").replace(/[^\w \-]/g, "").trim().replace(/\s+/g, "-");
  return base.slice(0, 80) || "thothica-edition";
}

type Row = {
  status: string;
  title: string | null;
  r2_doc_key: string | null;
  r2_md_key: string | null;
  r2_figures_prefix: string | null;
};

export async function buildDownload(
  env: Env,
  jobId: string,
  userId: number,
  format: string,
  render: RenderFn
): Promise<DownloadResult> {
  if (format !== "epub" && format !== "docx" && format !== "md") {
    return { ok: false, status: 400, error: "unknown format" };
  }
  const row = await env.DB.prepare(
    `SELECT status, title, r2_doc_key, r2_md_key, r2_figures_prefix
     FROM jobs WHERE id = ?1 AND user_id = ?2`
  )
    .bind(jobId, userId)
    .first<Row>();
  if (!row) return { ok: false, status: 404, error: "not found" };
  if (row.status !== "ready") return { ok: false, status: 409, error: "this document is not ready yet" };

  const name = safeTitle(row.title);

  if (format === "md") {
    const obj = row.r2_md_key ? await env.STORE.get(row.r2_md_key) : null;
    if (!obj) return { ok: false, status: 404, error: "not found" };
    return { ok: true, contentType: CONTENT_TYPE.md, filename: `${name}.md`, body: await obj.text() };
  }

  const docObj = row.r2_doc_key ? await env.STORE.get(row.r2_doc_key) : null;
  if (!docObj) return { ok: false, status: 404, error: "not found" };
  const docJson = JSON.parse(await docObj.text());

  const figures: { name: string; base64: string }[] = [];
  if (row.r2_figures_prefix) {
    const listed = await env.STORE.list({ prefix: row.r2_figures_prefix });
    for (const o of listed.objects) {
      const f = await env.STORE.get(o.key);
      if (!f) continue;
      figures.push({ name: o.key.slice(row.r2_figures_prefix.length), base64: bytesToBase64(new Uint8Array(await f.arrayBuffer())) });
    }
  }

  const bytes = await render(docJson, figures, format);
  return { ok: true, contentType: CONTENT_TYPE[format], filename: `${name}.${format}`, body: bytes };
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
