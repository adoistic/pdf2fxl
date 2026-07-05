/* Thothica Reflow · console interactions */
(() => {
  "use strict";
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const form = $("#convert-form");
  const fileInput = $("#file-input");
  const dropzone = $("#dropzone");
  const convertBtn = $("#convert-btn");
  const convertLabel = $("#convert-label");
  let currentFile = null;
  let poll = null;

  const fmtBytes = (n) => {
    if (n < 1024) return n + " B";
    if (n < 1048576) return (n / 1024).toFixed(0) + " KB";
    return (n / 1048576).toFixed(1) + " MB";
  };

  /* ---- file handling ---- */
  function setFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      flashDrop("That is not a PDF");
      return;
    }
    currentFile = file;
    dropzone.classList.add("has-file");
    $("#file-name").textContent = file.name;
    $("#file-size").textContent = fmtBytes(file.size);
    convertBtn.disabled = false;
    convertLabel.textContent = "Convert to reflowable";
  }
  function flashDrop(msg) {
    const hint = $(".dropzone__hint");
    if (!hint) return;
    const prev = hint.innerHTML;
    hint.innerHTML = "<b>" + msg + "</b>";
    setTimeout(() => (hint.innerHTML = prev), 1600);
  }

  fileInput.addEventListener("change", (e) => setFile(e.target.files[0]));
  ["dragenter", "dragover"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.add("drag");
    })
  );
  ["dragleave", "dragend", "drop"].forEach((ev) =>
    dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      dropzone.classList.remove("drag");
    })
  );
  dropzone.addEventListener("drop", (e) => {
    if (e.dataTransfer.files && e.dataTransfer.files[0]) setFile(e.dataTransfer.files[0]);
  });

  /* ---- segmented controls ---- */
  $$(".segmented").forEach((seg) =>
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      $$("button", seg).forEach((x) => x.setAttribute("aria-pressed", "false"));
      b.setAttribute("aria-pressed", "true");
    })
  );

  /* ---- chips (multi-select, keep >=1) ---- */
  $("#formats-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (!chip) return;
    const on = chip.getAttribute("aria-pressed") === "true";
    const active = $$(".chip[aria-pressed='true']", $("#formats-chips"));
    if (on && active.length === 1) return; // never zero
    chip.setAttribute("aria-pressed", on ? "false" : "true");
  });

  const segVal = (id) => $(`#${id} button[aria-pressed='true']`).dataset.val;
  const chipVals = () =>
    $$("#formats-chips .chip[aria-pressed='true']").map((c) => c.dataset.val);

  /* ---- state switching ---- */
  function showState(id) {
    $$(".result .state").forEach((s) => s.classList.remove("is-active"));
    $("#" + id).classList.add("is-active");
  }
  function setStages(stage) {
    const order = ["ocr", "measure", "hierarchy", "render"];
    const map = { ocr: 0, assemble: 2, render: 3, done: 4 };
    const reached = map[stage] ?? 0;
    $$(".stage").forEach((el, i) => {
      el.classList.toggle("done", i < reached);
      el.classList.toggle("active", i === reached && stage !== "done");
    });
  }
  function setProgress(stage, done, total) {
    let pct = 8;
    if (stage === "ocr" && total > 0) pct = 8 + (done / total) * 67;
    else if (stage === "assemble") pct = 80;
    else if (stage === "render") pct = 92;
    else if (stage === "done") pct = 100;
    pct = Math.min(100, Math.round(pct));
    $("#prog-bar").style.width = pct + "%";
    $("#prog-pct").textContent = pct + "%";
    const labels = {
      ocr: total ? `Reading page ${Math.min(done + 1, total)} of ${total}` : "Reading pages",
      assemble: "Recovering hierarchy",
      render: "Writing editions",
      done: "Finished",
    };
    $("#prog-left").textContent = labels[stage] || "Working";
    $("#work-sub").textContent =
      stage === "ocr" ? "Reading pages with Mistral OCR" :
      stage === "assemble" ? "Measuring type and clustering heading levels" :
      stage === "render" ? "Building EPUB, Markdown, and Word" : "Almost done";
  }

  /* ---- submit ---- */
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!currentFile) return;
    const fd = new FormData();
    fd.append("file", currentFile);
    fd.append("title", $("#title-input").value.trim());
    fd.append("layout", segVal("layout-seg"));
    fd.append("tables", segVal("tables-seg"));
    chipVals().forEach((f) => fd.append("formats", f));

    $("#result-title").textContent = "Converting";
    $("#result-step").textContent = "Working";
    showState("state-working");
    setStages("ocr");
    setProgress("ocr", 0, 0);

    try {
      const r = await fetch("/api/convert", { method: "POST", body: fd });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || "Upload failed");
      startPolling(data.id);
    } catch (err) {
      fail(err.message);
    }
  });

  function startPolling(id) {
    clearInterval(poll);
    poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/jobs/${id}`);
        const j = await r.json();
        if (j.status === "error") {
          clearInterval(poll);
          return fail(j.error || "Conversion failed");
        }
        setStages(j.stage);
        setProgress(j.stage, j.ocr_done || 0, j.ocr_total || 0);
        if (j.status === "done") {
          clearInterval(poll);
          renderDone(id, j.result);
        }
      } catch (err) {
        clearInterval(poll);
        fail("Lost connection to the server");
      }
    }, 700);
  }

  /* ---- done ---- */
  const FMT = {
    epub: { label: "EPUB", note: "Reflowable e-book", icon: '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z"/>' },
    md: { label: "Markdown", note: "Structured text", icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M9 15v-3l1.5 2L12 12v3"/><path d="M15.5 12v3"/>' },
    docx: { label: "Word", note: "Editable document", icon: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="m9 13 1.5 5 1.5-3.5L13.5 18 15 13"/>' },
  };
  function renderDone(id, res) {
    $("#result-title").textContent = res.title || "Reflowable edition";
    $("#result-step").textContent = "Ready";

    const s = res.stats || {};
    const cells = [
      ["Pages", s.pages], ["Headings", s.headings], ["Chapters", s.h1], ["Figures", s.figures],
    ].filter(([, v]) => v !== undefined && v !== null);
    $("#summary").innerHTML = cells
      .map(([k, v]) => `<div class="stat"><b class="tnum">${v}</b><span>${k}</span></div>`)
      .join("");

    const toc = res.toc || [];
    $("#toc-count").textContent = `${s.headings ?? toc.length} headings`;
    $("#toc").innerHTML = toc.length
      ? toc.map((h) => {
          const lv = Math.max(1, Math.min(6, h.level));
          const pad = 16 + (lv - 1) * 18;
          return `<div class="tocitem h${lv}" style="padding-left:${pad}px">
            <span class="lvtag">H${lv}</span><span class="txt">${escapeHtml(h.text)}</span></div>`;
        }).join("")
      : `<div class="tocitem"><span class="txt" style="color:var(--body)">No headings were detected in this book.</span></div>`;

    $("#downloads").innerHTML = (res.downloads || [])
      .map((d) => {
        const meta = FMT[d.fmt] || { label: d.fmt.toUpperCase(), note: "File", icon: "" };
        return `<a class="dl" href="${d.url}" download>
          <span class="ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${meta.icon}</svg></span>
          <span class="m"><b>${meta.label}</b><span>${d.size} · ${meta.note}</span></span></a>`;
      }).join("");

    showState("state-done");
  }

  function fail(msg) {
    $("#result-title").textContent = "Result";
    $("#result-step").textContent = "Step 02";
    $("#err-msg").textContent = msg || "Something went wrong.";
    showState("state-error");
  }
  $("#err-retry").addEventListener("click", () => {
    $("#result-title").textContent = "Result";
    showState("state-empty");
  });

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* resume a conversion from a shareable link: /?job=<id> */
  const resumeId = new URLSearchParams(location.search).get("job");
  if (resumeId) {
    $("#result-title").textContent = "Converting";
    $("#result-step").textContent = "Working";
    showState("state-working");
    setStages("ocr");
    setProgress("ocr", 0, 0);
    startPolling(resumeId);
  }
})();
