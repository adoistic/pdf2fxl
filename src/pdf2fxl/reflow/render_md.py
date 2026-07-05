from __future__ import annotations

from .docmodel import Doc, Heading, Paragraph, Figure, Table, Formula, ChapterBreak


def _runs_md(runs) -> str:
    out = []
    for r in runs:
        t = r.text
        if r.bold:
            t = f"**{t}**"
        if r.italic:
            t = f"*{t}*"
        out.append(t)
    return "".join(out)


def render_markdown(doc: Doc) -> str:
    lines = [f"# {doc.title}", ""]
    for n in doc.nodes:
        if isinstance(n, ChapterBreak):
            continue
        if isinstance(n, Heading):
            lines += ["#" * min(6, max(1, n.level)) + f" {n.text}", ""]
        elif isinstance(n, Paragraph):
            lines += [_runs_md(n.runs), ""]
        elif isinstance(n, Figure):
            lines += [f"![{n.caption or ''}]({n.src})", ""]
        elif isinstance(n, Table):
            lines += [n.image_src and f"![]({n.image_src})" or (n.html or ""), ""]
        elif isinstance(n, Formula):
            lines += [n.text or (n.image_src and f"![]({n.image_src})") or "", ""]
    return "\n".join(lines).strip() + "\n"
