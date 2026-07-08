import {
  initAuth,
  signInWithGoogle,
  sendMagicLink,
  signOutUser,
  getToken,
  completeMagicLink,
} from "./firebase.js";

const loginView = document.getElementById("login-view");
const appView = document.getElementById("app-view");
const googleButton = document.getElementById("google-signin-button");
const magicLinkEmail = document.getElementById("magic-link-email");
const magicLinkButton = document.getElementById("magic-link-button");
const magicLinkStatus = document.getElementById("magic-link-status");
const userEmail = document.getElementById("user-email");
const signOutButton = document.getElementById("sign-out-button");

const adminLink = document.getElementById("admin-link");
const balanceChip = document.getElementById("balance-chip");
const balanceAmount = document.getElementById("balance-amount");
const dropZone = document.getElementById("drop-zone");
const dropZoneLine = document.getElementById("drop-zone-line");
const dropZoneFile = document.getElementById("drop-zone-file");
const fileInput = document.getElementById("file-input");
const titleField = document.getElementById("title-field");
const jobTitle = document.getElementById("job-title");
const queueList = document.getElementById("queue-list");
const queueCount = document.getElementById("queue-count");
const queueFiles = document.getElementById("queue-files");
const queueClear = document.getElementById("queue-clear");
const ratePerPage = document.getElementById("rate-per-page");
const enrichField = document.getElementById("enrich-field");
const enrichToggle = document.getElementById("enrich-toggle");
const enrichPrice = document.getElementById("enrich-price");
const uploadButton = document.getElementById("upload-button");
const uploadStatus = document.getElementById("upload-status");
const uploadProgress = document.getElementById("upload-progress");
const uploadProgressBar = document.getElementById("upload-progress-bar");
const uploadProgressText = document.getElementById("upload-progress-text");

// Two-phase bulk panel: counting, the affordability gate, then the remaining
// indicator. Only one block is visible at a time.
const bulkPanel = document.getElementById("bulk-panel");
const bulkCounting = document.getElementById("bulk-counting");
const bulkCountBar = document.getElementById("bulk-count-bar");
const bulkCountText = document.getElementById("bulk-count-text");
const bulkCountNote = document.getElementById("bulk-count-note");
const bulkGate = document.getElementById("bulk-gate");
const bulkGateSummary = document.getElementById("bulk-gate-summary");
const bulkGateBalance = document.getElementById("bulk-gate-balance");
const bulkGateMessage = document.getElementById("bulk-gate-message");
const bulkProcessAll = document.getElementById("bulk-process-all");
const bulkProcessFits = document.getElementById("bulk-process-fits");
const bulkCancel = document.getElementById("bulk-cancel");
const bulkProcessing = document.getElementById("bulk-processing");
const bulkProcBar = document.getElementById("bulk-proc-bar");
const bulkProcText = document.getElementById("bulk-proc-text");
const bulkProcNote = document.getElementById("bulk-proc-note");

const jobsList = document.getElementById("jobs-list");
const jobsCount = document.getElementById("jobs-count");

const translateView = document.getElementById("translate-view");
const translateLink = document.getElementById("translate-link");
const translateBackLink = document.getElementById("translate-back-link");
const translateEmail = document.getElementById("translate-email");
const translateBalanceAmount = document.getElementById("translate-balance-amount");
const translateSignOutButton = document.getElementById("translate-sign-out-button");
const trTabText = document.getElementById("trtab-text");
const trTabBook = document.getElementById("trtab-book");
const translateTextField = document.getElementById("translate-text-field");
const translateText = document.getElementById("translate-text");
const translateBookField = document.getElementById("translate-book-field");
const translateBook = document.getElementById("translate-book");
const translateLanguage = document.getElementById("translate-language");
const translateButton = document.getElementById("translate-button");
const translatePrice = document.getElementById("translate-price");
const translateStatus = document.getElementById("translate-status");
const translationsList = document.getElementById("translations-list");
const translationsCount = document.getElementById("translations-count");
const translationDrawer = document.getElementById("translation-drawer");
const translationSub = document.getElementById("translation-sub");
const translationCopy = document.getElementById("translation-copy");
const translationDownloads = document.getElementById("translation-downloads");
const translationTextBody = document.getElementById("translation-text-body");
const translationClose = document.getElementById("translation-close");

const adminView = document.getElementById("admin-view");
const adminEmail = document.getElementById("admin-email");
const adminBackLink = document.getElementById("admin-back-link");
const adminSignOutButton = document.getElementById("admin-sign-out-button");
const allocateEmail = document.getElementById("allocate-email");
const allocateCredits = document.getElementById("allocate-credits");
const allocateNote = document.getElementById("allocate-note");
const allocateButton = document.getElementById("allocate-button");
const allocateStatus = document.getElementById("allocate-status");
const usersList = document.getElementById("users-list");
const usersCount = document.getElementById("users-count");
const ledgerDrawer = document.getElementById("ledger-drawer");
const ledgerTitle = document.getElementById("ledger-title");
const ledgerSub = document.getElementById("ledger-sub");
const ledgerBody = document.getElementById("ledger-body");
const ledgerClose = document.getElementById("ledger-close");

// Per page prices, in credits. Keep in sync with cloud/worker/src/ledger.ts.
const RATES = { reflow: 0.7, fixed: 3.0 };
// Emphasis add-on: availability + per-page surcharge come from /api/config so the
// checkbox only shows when a model + key are configured server-side.
let enrichAvailable = false;
let enrichRate = 0.2;

const STATUS_LABELS = {
  received: "Received",
  preparing: "Reading your pages",
  processing: "Reading your pages",
  ready: "Ready",
  failed: "Failed",
};
const TERMINAL_STATUSES = new Set(["ready", "failed"]);
const MODE_LABELS = { reflow: "Reflowable edition", fixed: "Fixed layout edition" };
const POLL_MS = 10_000;

// Ledger kinds rendered as friendly words. See cloud/worker/src/ledger.ts.
const LEDGER_KIND_LABELS = {
  allocation: "Allocation",
  hold: "Hold",
  capture: "Charge",
  release: "Refund",
};
const MCR_PER_CREDIT = 1000;

// ---------------------------------------------------------------------------
// Preview fixtures. `?preview-fixtures` (or `?preview-fixtures=empty`) renders
// the signed in shell with canned data so the app view can be screenshotted
// without a real session. Localhost only, and it only short circuits the
// initial render below: it never fakes or intercepts real API calls, and
// polling stays off so nothing hits the worker unauthenticated.
// ---------------------------------------------------------------------------
const previewFixtures =
  (location.hostname === "127.0.0.1" || location.hostname === "localhost") &&
  location.search.includes("preview-fixtures");

function agoIso(ms) {
  return new Date(Date.now() - ms).toISOString();
}

const FIXTURE_ME = {
  email: "reader@example.com",
  name: "Preview Reader",
  isAdmin: true,
  balance: 42.7,
  // Present so the hidden Translate view can be screenshotted via fixtures.
  translate: { maxWords: 2000, blockWords: 350, blockCredits: 500 },
};

const FIXTURE_JOBS = [
  // A solo (ungrouped) job, still received, renders exactly as before.
  { id: "fx-1", bulkId: null, mode: "reflow", status: "received", title: "Mughal Gardens survey", pageCount: null, error: null, createdAt: agoIso(40 * 1000) },
  // A bulk group of five books sharing one bulkId, mixed statuses incl. two ready.
  { id: "fx-b1", bulkId: "grp-fx", mode: "reflow", status: "processing", title: "Kitab al-Aghani, volume 3", pageCount: 388, error: null, createdAt: agoIso(9 * 60 * 1000) },
  { id: "fx-b2", bulkId: "grp-fx", mode: "reflow", status: "ready", title: "The Deccan Sultanates", pageCount: 412, error: null, createdAt: agoIso(9 * 60 * 1000) },
  { id: "fx-b3", bulkId: "grp-fx", mode: "reflow", status: "preparing", title: "Persian Miniatures, plates", pageCount: null, error: null, createdAt: agoIso(9 * 60 * 1000) },
  { id: "fx-b4", bulkId: "grp-fx", mode: "reflow", status: "ready", title: "A Grammar of the Persian Language", pageCount: 214, error: null, createdAt: agoIso(9 * 60 * 1000) },
  { id: "fx-b5", bulkId: "grp-fx", mode: "reflow", status: "failed", title: "Field notebook, 1911", pageCount: null, error: "we could not read this file", createdAt: agoIso(9 * 60 * 1000) },
  // A second solo job, ready, below the group.
  { id: "fx-2", bulkId: null, mode: "fixed", status: "ready", title: "Mir'at al-Zaman chronicle", pageCount: 96, error: null, createdAt: agoIso(30 * 60 * 60 * 1000) },
];

// After "process what fits": the books that fit are being read, the rest were
// left uncharged and sit as "waiting for credits". Drives the group card so the
// waiting state can be screenshotted.
const FIXTURE_JOBS_WAITING = [
  { id: "fx-w1", bulkId: "grp-w", mode: "reflow", status: "processing", title: "Kitab al-Aghani, volume 3", pageCount: 388, error: null, createdAt: agoIso(2 * 60 * 1000) },
  { id: "fx-w2", bulkId: "grp-w", mode: "reflow", status: "preparing", title: "The Deccan Sultanates", pageCount: 412, error: null, createdAt: agoIso(2 * 60 * 1000) },
  { id: "fx-w3", bulkId: "grp-w", mode: "reflow", status: "received", title: "Persian Miniatures, plates", pageCount: 260, error: null, createdAt: agoIso(2 * 60 * 1000) },
  { id: "fx-w4", bulkId: "grp-w", mode: "reflow", status: "received", title: "A Grammar of the Persian Language", pageCount: 214, error: null, createdAt: agoIso(2 * 60 * 1000) },
];

const FIXTURE_USERS = [
  { id: 7, email: "adnan@thothica.com", name: "Adnan", isAdmin: true, balance: 1280.0 },
  { id: 6, email: "reader@example.com", name: "Preview Reader", isAdmin: false, balance: 42.7 },
  { id: 5, email: "amina.karim@example.com", name: "Amina Karim", isAdmin: false, balance: 318.5 },
  { id: 4, email: "j.okafor@example.com", name: null, isAdmin: false, balance: 0.0 },
  { id: 3, email: "editorial@heritagepress.example", name: "Heritage Press", isAdmin: false, balance: -6.3 },
  { id: 2, email: "student.aziz@example.edu", name: "Aziz R.", isAdmin: false, balance: 4.2 },
];

// Newest first, as the ledger API returns it. Amounts are milli-credits.
const FIXTURE_LEDGER = [
  { kind: "capture", amountMcr: 0, jobId: "a1b2c3d4e5f6", refId: 41, note: null, createdBy: null, createdAt: agoIso(20 * 60 * 1000) },
  { kind: "hold", amountMcr: -149800, jobId: "a1b2c3d4e5f6", refId: null, note: null, createdBy: null, createdAt: agoIso(22 * 60 * 1000) },
  { kind: "release", amountMcr: 67200, jobId: "9f8e7d6c5b4a", refId: 38, note: null, createdBy: null, createdAt: agoIso(6 * 60 * 60 * 1000) },
  { kind: "hold", amountMcr: -67200, jobId: "9f8e7d6c5b4a", refId: null, note: null, createdBy: null, createdAt: agoIso(6 * 60 * 60 * 1000 + 90 * 1000) },
  { kind: "allocation", amountMcr: 250000, jobId: null, refId: null, note: "welcome credits", createdBy: "adnan@thothica.com", createdAt: agoIso(2 * 24 * 60 * 60 * 1000) },
  { kind: "allocation", amountMcr: 100000, jobId: null, refId: null, note: null, createdBy: "adnan@thothica.com", createdAt: agoIso(9 * 24 * 60 * 60 * 1000) },
  { kind: "allocation", amountMcr: -15000, jobId: null, refId: null, note: "double charge correction", createdBy: "adnan@thothica.com", createdAt: agoIso(11 * 24 * 60 * 60 * 1000) },
];

// ---------------------------------------------------------------------------
// View switching
// ---------------------------------------------------------------------------
// True once a signed in (or fixture) session exists. Gates the #admin route so
// the hash cannot flip to the admin view before we know the user, and gates it
// on isAdmin so the link and section never render for non admins. The server
// enforces 403 regardless; this is only about not showing what is not theirs.
let sessionReady = false;
let sessionIsAdmin = false;

function showLogin() {
  loginView.hidden = false;
  appView.hidden = true;
  adminView.hidden = true;
  translateView.hidden = true;
  stopPolling();
  stopTranslatePolling();
}

function showApp() {
  loginView.hidden = true;
  adminView.hidden = true;
  translateView.hidden = true;
  appView.hidden = false;
}

function showAdmin() {
  loginView.hidden = true;
  appView.hidden = true;
  translateView.hidden = true;
  adminView.hidden = false;
}

function showTranslate() {
  loginView.hidden = true;
  appView.hidden = true;
  adminView.hidden = true;
  translateView.hidden = false;
}

// Routes the current hash to a view. Only #admin (admins) and #translate
// (readers the backend enabled) leave the app view; everything else falls
// back to it, and a stale hash is dropped so the option stays invisible.
function routeHash() {
  if (!sessionReady) return;
  if (location.hash === "#admin" && sessionIsAdmin) {
    showAdmin();
    loadAdminData();
    return;
  }
  if (location.hash === "#translate" && sessionTranslate) {
    showTranslate();
    loadTranslateData();
    return;
  }
  if (location.hash === "#admin" || location.hash === "#translate") {
    history.replaceState(null, "", location.pathname + location.search);
  }
  showApp();
}

// Attaches the current user's Firebase ID token as a Bearer token, parses the
// JSON error envelope ({ error: string }) on failure, and flips to the login
// view on 401 (the session is no longer valid).
export async function api(path, opts = {}) {
  const token = await getToken();
  const headers = new Headers(opts.headers || {});
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }
  const response = await fetch(path, { ...opts, headers });

  if (response.status === 401) {
    showLogin();
  }

  if (!response.ok) {
    let message = `request failed (${response.status})`;
    try {
      const body = await response.json();
      if (body && typeof body.error === "string") {
        message = body.error;
      }
    } catch {
      // response body was not JSON; fall back to the generic message
    }
    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  if (response.status === 204) {
    return null;
  }
  return response.json();
}

// ---------------------------------------------------------------------------
// Account: balance chip and admin link
// ---------------------------------------------------------------------------
let currentBalance = null;

// The hidden translation option: null unless the backend enabled it for this
// account. When set it carries the terms {maxWords, blockWords, blockCredits}.
let sessionTranslate = null;

function renderMe(me) {
  currentBalance = me.balance;
  balanceAmount.textContent = `${me.balance.toFixed(1)} credits`;
  balanceChip.hidden = false;
  sessionIsAdmin = !!me.isAdmin;
  adminLink.hidden = !me.isAdmin;
  sessionTranslate = me.translate || null;
  translateLink.hidden = !sessionTranslate;
  translateBalanceAmount.textContent = `${me.balance.toFixed(1)} credits`;
  if (me.email) {
    userEmail.textContent = me.email;
    adminEmail.textContent = me.email;
    translateEmail.textContent = me.email;
  }
}

async function refreshMe() {
  renderMe(await api("/api/me"));
}

// ---------------------------------------------------------------------------
// Jobs list
// ---------------------------------------------------------------------------
let pollTimer = null;

function stopPolling() {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// D1 timestamps arrive as "YYYY-MM-DD HH:MM:SS" in UTC; fixtures are ISO.
function parseTime(value) {
  if (!value) return null;
  const iso = value.includes("T") ? value : value.replace(" ", "T") + "Z";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timeAgo(value) {
  const date = parseTime(value);
  if (!date) return "";
  const seconds = Math.max(0, (Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return minutes === 1 ? "a minute ago" : `${minutes} minutes ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return hours === 1 ? "an hour ago" : `${hours} hours ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function statusClass(status) {
  if (status === "ready") return "status--ready";
  if (status === "failed") return "status--failed";
  if (status === "received") return "";
  return "status--active";
}

function renderEmptyState() {
  const card = el("div", "empty");
  const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  icon.setAttribute("class", "empty__icon");
  icon.setAttribute("viewBox", "0 0 24 24");
  icon.setAttribute("width", "34");
  icon.setAttribute("height", "34");
  icon.setAttribute("fill", "none");
  icon.setAttribute("stroke", "currentColor");
  icon.setAttribute("stroke-width", "1.5");
  icon.setAttribute("stroke-linecap", "round");
  icon.setAttribute("stroke-linejoin", "round");
  icon.setAttribute("aria-hidden", "true");
  icon.innerHTML =
    '<path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20V4a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 0 4 5.5v14z"/>' +
    '<path d="M4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5"/><path d="M9 8h7"/><path d="M9 12h5"/>';
  card.appendChild(icon);
  card.appendChild(el("h3", "empty__title", "Your first scan goes here."));
  card.appendChild(
    el(
      "p",
      "empty__body",
      "Choose a PDF in the upload panel and we will measure the type on every page, " +
        "recover the real chapter structure, and hand back a clean edition."
    )
  );
  return card;
}

function renderJob(job) {
  const row = el("article", "job");

  const main = el("div", "job__main");
  const titleRow = el("div", "job__titlerow");
  titleRow.appendChild(el("h3", "job__title", job.title || "Untitled scan"));
  main.appendChild(titleRow);

  const meta = [MODE_LABELS[job.mode] || job.mode];
  if (job.pageCount) {
    meta.push(job.pageCount === 1 ? "1 page" : `${job.pageCount} pages`);
  }
  const ago = timeAgo(job.createdAt);
  if (ago) meta.push(ago);
  main.appendChild(el("p", "job__meta", meta.join("  ·  ")));

  if (job.status === "failed" && job.error) {
    main.appendChild(el("p", "job__error", sentence(job.error)));
  }

  if (job.status === "ready") {
    main.appendChild(renderDownloads(job));
  }
  row.appendChild(main);

  const chip = el("span", `status ${statusClass(job.status)}`.trim());
  chip.appendChild(el("span", "status__dot"));
  chip.appendChild(document.createTextNode(STATUS_LABELS[job.status] || job.status));
  row.appendChild(chip);

  return row;
}

// The three downloadable formats. Labels are reader facing, `format` is the
// query value the download route expects.
const DOWNLOAD_FORMATS = [
  { format: "epub", label: "EPUB" },
  { format: "docx", label: "Word" },
  { format: "md", label: "Markdown" },
];

function renderDownloads(job) {
  const wrap = el("div", "downloads");
  for (const { format, label } of DOWNLOAD_FORMATS) {
    const button = el("button", "download-btn", label);
    button.type = "button";
    button.addEventListener("click", () => downloadArtifact(job, format, button, wrap));
    wrap.appendChild(button);
  }
  const err = el("p", "downloads__error");
  err.hidden = true;
  wrap.appendChild(err);
  return wrap;
}

// The download route needs the Firebase bearer token, so a plain link cannot
// carry it. Fetch with the same token source api() uses, turn the response
// into a blob, and click a throwaway object URL so the browser saves the file.
// `button`/`wrap` are the per-format button and its error slot when a reader
// clicks one download. The bulk "download all" path calls this without them
// (it manages its own button and lets errors surface through the console),
// so both are optional. Returns true on success.
async function downloadArtifact(job, format, button, wrap) {
  const err = wrap ? wrap.querySelector(".downloads__error") : null;
  if (err) err.hidden = true;
  let label;
  if (button) {
    button.disabled = true;
    button.classList.add("is-loading");
    label = button.textContent;
    button.textContent = "Preparing...";
  }

  try {
    const token = await getToken();
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    // Stored artifacts (md, doc) may answer with a 302 to a presigned R2 url when
    // R2-direct is on; renders (epub, docx) stream the bytes back directly.
    // "follow" (the default) lets the browser chase the redirect to R2. The
    // browser drops the Authorization header when following a cross-origin
    // redirect, and the presigned url needs no auth, so the R2 request succeeds.
    const response = await fetch(
      `/api/jobs/${job.id}/download?format=${format}`,
      { headers, redirect: "follow" }
    );
    if (!response.ok) {
      throw new Error(`request failed (${response.status})`);
    }
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = downloadName(job, format);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch (e) {
    console.error("download failed", e);
    if (err) {
      err.textContent = "That download did not come through. Try again in a moment.";
      err.hidden = false;
    }
    return false;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove("is-loading");
      button.textContent = label;
    }
  }
}

// A friendly filename from the title, never an internal id. The server sets the
// real content-disposition; this is the fallback the object URL click uses.
function downloadName(job, format) {
  const base = (job.title || "edition")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "edition";
  return `${base}.${format}`;
}

// Group jobs by bulkId while preserving the list's original order. Solo jobs
// (no bulkId) stay solo; a bulk card is anchored at the position of its first
// member, so the timeline stays intact.
function groupJobs(jobs) {
  const groups = new Map(); // bulkId -> { bulkId, jobs: [] }
  const order = []; // entries in first-seen order: a solo job, or a group ref
  for (const job of jobs) {
    if (!job.bulkId) {
      order.push({ solo: job });
      continue;
    }
    let group = groups.get(job.bulkId);
    if (!group) {
      group = { bulkId: job.bulkId, jobs: [] };
      groups.set(job.bulkId, group);
      order.push({ group });
    }
    group.jobs.push(job);
  }
  return order;
}

function renderJobs(jobs) {
  jobsList.replaceChildren();
  if (jobs.length === 0) {
    jobsCount.hidden = true;
    jobsList.appendChild(renderEmptyState());
  } else {
    jobsCount.hidden = false;
    jobsCount.textContent = jobs.length === 1 ? "1 edition" : `${jobs.length} editions`;
    for (const entry of groupJobs(jobs)) {
      if (entry.solo) {
        jobsList.appendChild(renderJob(entry.solo));
      } else {
        jobsList.appendChild(renderBulkGroup(entry.group));
      }
    }
  }
  updateProcessingIndicator(jobs);
  schedulePoll(jobs);
}

// One bulk card: a header summarising the group, then a book row per member.
function renderBulkGroup(group) {
  const members = group.jobs;
  const ready = members.filter((j) => j.status === "ready");
  const failed = members.filter((j) => j.status === "failed").length;
  // A book still in "received" was uploaded but not started: in the over-budget
  // path it was left uncharged, waiting for credits. Everything else that is not
  // terminal is actively being read.
  const waiting = members.filter((j) => j.status === "received").length;
  const inProgress = members.filter(
    (j) => !TERMINAL_STATUSES.has(j.status) && j.status !== "received"
  ).length;

  const card = el("article", "bulk");

  const head = el("div", "bulk__head");
  const heading = el("div", "bulk__heading");
  const count = members.length;
  heading.appendChild(el("h3", "bulk__title",
    count === 1 ? "1 book uploaded together" : `${count} books uploaded together`));

  // Warm, plain progress summary: only the parts that apply.
  const summary = [];
  if (ready.length) summary.push(`${ready.length} ready`);
  if (inProgress) summary.push(`${inProgress} in progress`);
  if (waiting) summary.push(waiting === 1 ? "1 waiting for credits" : `${waiting} waiting for credits`);
  if (failed) summary.push(failed === 1 ? "1 could not be read" : `${failed} could not be read`);
  heading.appendChild(el("p", "bulk__summary", summary.join("  ·  ")));
  head.appendChild(heading);

  if (ready.length) {
    const allBtn = el("button", "download-btn download-btn--all",
      ready.length === 1 ? "Download the ready book" : "Download all as separate files");
    allBtn.type = "button";
    allBtn.addEventListener("click", () => downloadAll(ready, allBtn));
    head.appendChild(allBtn);
  }
  card.appendChild(head);

  const rows = el("div", "bulk__rows");
  for (const job of members) {
    rows.appendChild(renderBookRow(job));
  }
  card.appendChild(rows);

  return card;
}

// A book row inside a bulk card: title, meta, status, and per-book downloads
// when ready. Lighter chrome than a solo job card, since the card frames them.
function renderBookRow(job) {
  const row = el("div", "book");

  const main = el("div", "book__main");
  main.appendChild(el("h4", "book__title", job.title || "Untitled scan"));

  const meta = [];
  if (job.pageCount) meta.push(job.pageCount === 1 ? "1 page" : `${job.pageCount} pages`);
  if (meta.length) main.appendChild(el("p", "book__meta", meta.join("  ·  ")));

  if (job.status === "failed" && job.error) {
    main.appendChild(el("p", "book__error", sentence(job.error)));
  }
  if (job.status === "ready") {
    main.appendChild(renderDownloads(job));
  }
  row.appendChild(main);

  // Inside a group, a "received" book was uploaded but not started (the
  // over-budget path leaves it uncharged), so it reads as waiting for credits.
  const label =
    job.status === "received" ? "Waiting for credits" : STATUS_LABELS[job.status] || job.status;
  const chip = el("span", `status ${statusClass(job.status)}`.trim());
  chip.appendChild(el("span", "status__dot"));
  chip.appendChild(document.createTextNode(label));
  row.appendChild(chip);

  return row;
}

// Download every ready book in the group, one after another. There is no
// server-side zip yet, so this triggers several separate file downloads; the
// button label says so. A small gap between clicks keeps the browser from
// dropping downloads that fire too close together.
async function downloadAll(readyJobs, button) {
  button.disabled = true;
  const restLabel = button.textContent;
  button.textContent = "Preparing...";
  try {
    for (const job of readyJobs) {
      await downloadArtifact(job, "epub");
      await new Promise((resolve) => setTimeout(resolve, 400));
    }
  } finally {
    button.disabled = false;
    button.textContent = restLabel;
  }
}

// Poll while anything is still moving; ready and failed are terminal.
function schedulePoll(jobs) {
  stopPolling();
  if (previewFixtures) return; // fixtures never touch the real API
  if (!jobs.some((job) => !TERMINAL_STATUSES.has(job.status))) return;
  pollTimer = setTimeout(async () => {
    pollTimer = null;
    try {
      await refreshJobs();
      await refreshMe();
    } catch (err) {
      console.error("poll failed", err);
    }
  }, POLL_MS);
}

async function refreshJobs() {
  const data = await api("/api/jobs");
  renderJobs(data.jobs || []);
}

function sentence(text) {
  if (!text) return "";
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// ---------------------------------------------------------------------------
// Admin: readers table, allocation, and per reader statement drawer
// ---------------------------------------------------------------------------
function formatBalance(credits) {
  // Match the balance chip: one decimal, warm and plain.
  return credits.toFixed(1);
}

function renderUsers(users) {
  usersList.replaceChildren();
  if (users.length === 0) {
    usersCount.hidden = true;
    usersList.appendChild(el("div", "users__empty", "No readers yet."));
    return;
  }
  usersCount.hidden = false;
  usersCount.textContent = users.length === 1 ? "1 reader" : `${users.length} readers`;

  for (const user of users) {
    const row = el("button", "urow");
    row.type = "button";
    row.setAttribute("role", "row");
    row.addEventListener("click", () => openLedger(user));

    const who = el("div", "urow__who");
    const emailWrap = el("div", "urow__email");
    emailWrap.appendChild(el("span", "urow__emailtext", user.email));
    if (user.isAdmin) {
      emailWrap.appendChild(el("span", "urow__badge", "Admin"));
    }
    who.appendChild(emailWrap);
    row.appendChild(who);

    const name = user.name
      ? el("div", "urow__name", user.name)
      : el("div", "urow__name urow__name--empty", "no name");
    row.appendChild(name);

    const bal = el("div", "urow__bal");
    if (user.balance < 0) bal.classList.add("urow__bal--neg");
    bal.appendChild(el("span", "users__label", "Balance"));
    bal.appendChild(document.createTextNode(formatBalance(user.balance)));
    bal.appendChild(el("span", "urow__bal-unit", "credits"));
    row.appendChild(bal);

    usersList.appendChild(row);
  }
}

async function refreshUsers() {
  if (previewFixtures) {
    renderUsers(FIXTURE_USERS);
    return;
  }
  const data = await api("/api/admin/users");
  renderUsers(data.users || []);
}

// Loaded on entry to the admin view. Only fetches once per visit unless the
// allocation form forces a refresh; keeps the panel calm and cheap.
async function loadAdminData() {
  try {
    await refreshUsers();
  } catch (err) {
    console.error("failed to load readers", err);
    usersList.replaceChildren(
      el("div", "users__empty", "We could not load the readers. Try again in a moment.")
    );
  }
}

function showAllocateStatus(message, kind) {
  allocateStatus.textContent = message;
  allocateStatus.classList.toggle("upload-status--error", kind === "error");
  allocateStatus.hidden = false;
}

async function submitAllocation() {
  const email = allocateEmail.value.trim().toLowerCase();
  const creditsRaw = allocateCredits.value.trim();
  const credits = Number(creditsRaw);
  const note = allocateNote.value.trim();

  if (!email.includes("@")) {
    showAllocateStatus("Enter the reader's email address.", "error");
    return;
  }
  if (!creditsRaw || !Number.isFinite(credits) || credits === 0) {
    showAllocateStatus("Enter a non zero number of credits.", "error");
    return;
  }

  allocateButton.disabled = true;
  const restLabel = allocateButton.textContent;
  allocateButton.textContent = "Allocating...";

  try {
    const result = await api("/api/admin/credits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, credits, note: note || null }),
    });
    const amount = Math.abs(credits);
    const verb = credits < 0 ? "Took back" : "Allocated";
    const unit = amount === 1 ? "credit" : "credits";
    showAllocateStatus(
      `${verb} ${String(amount)} ${unit} ${credits < 0 ? "from" : "to"} ${result.email}. ` +
        `New balance ${formatBalance(result.balance)}.`
    );
    allocateEmail.value = "";
    allocateCredits.value = "";
    allocateNote.value = "";
    await refreshUsers();
  } catch (err) {
    // 400 arrives here with the server's envelope ("invalid request").
    const msg =
      err.status === 400
        ? "That allocation was not valid. Check the email and amount."
        : `${sentence(err.message)}.`;
    showAllocateStatus(msg, "error");
  } finally {
    allocateButton.disabled = false;
    allocateButton.textContent = restLabel;
  }
}

// ---- statement drawer ------------------------------------------------------
let lastFocusedRow = null;

function renderLedgerEntry(entry) {
  const item = el("div", "ledger__entry");

  item.appendChild(el("span", "ledger__kind", LEDGER_KIND_LABELS[entry.kind] || entry.kind));

  const credits = entry.amountMcr / MCR_PER_CREDIT;
  const amount = el("span", "ledger__amount");
  if (credits > 0) {
    amount.classList.add("ledger__amount--pos");
    amount.textContent = `+${formatBalance(credits)}`;
  } else if (credits < 0) {
    amount.classList.add("ledger__amount--neg");
    amount.textContent = formatBalance(credits);
  } else {
    amount.classList.add("ledger__amount--zero");
    amount.textContent = "0.0";
  }
  item.appendChild(amount);

  const meta = el("div", "ledger__meta");
  const parts = [];
  if (entry.note) parts.push(el("span", "ledger__note", entry.note));
  if (entry.jobId) parts.push(el("span", "ledger__job", `job ${entry.jobId.slice(0, 8)}`));
  const when = timeAgo(entry.createdAt);
  if (when) parts.push(el("span", "ledger__when", when));
  if (entry.createdBy) parts.push(el("span", "ledger__who", `by ${entry.createdBy}`));

  parts.forEach((part, i) => {
    if (i > 0) meta.appendChild(el("span", "ledger__dot", "·"));
    meta.appendChild(part);
  });
  item.appendChild(meta);

  return item;
}

function renderLedger(entries) {
  ledgerBody.replaceChildren();
  if (entries.length === 0) {
    ledgerBody.appendChild(el("div", "ledger__empty", "No credit activity yet."));
    return;
  }
  const list = el("div", "ledger");
  for (const entry of entries) {
    list.appendChild(renderLedgerEntry(entry));
  }
  ledgerBody.appendChild(list);
}

async function openLedger(user) {
  lastFocusedRow = document.activeElement;
  ledgerTitle.textContent = "Statement";
  ledgerSub.textContent = user.email;
  ledgerBody.replaceChildren(el("div", "ledger__empty", "Loading..."));
  ledgerDrawer.hidden = false;
  document.body.style.overflow = "hidden";
  ledgerClose.focus();

  try {
    const data = previewFixtures
      ? { entries: FIXTURE_LEDGER }
      : await api(`/api/admin/users/${user.id}/ledger`);
    renderLedger(data.entries || []);
  } catch (err) {
    console.error("failed to load statement", err);
    ledgerBody.replaceChildren(
      el("div", "ledger__empty", "We could not load this statement. Try again in a moment.")
    );
  }
}

function closeLedger() {
  ledgerDrawer.hidden = true;
  document.body.style.overflow = "";
  if (lastFocusedRow && typeof lastFocusedRow.focus === "function") {
    lastFocusedRow.focus();
  }
}

function wireAdminPanel() {
  allocateButton.addEventListener("click", () => {
    submitAllocation().catch((err) => console.error("allocation failed", err));
  });
  allocateNote.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submitAllocation().catch((err) => console.error("allocation failed", err));
    }
  });

  adminBackLink.addEventListener("click", (event) => {
    event.preventDefault();
    history.replaceState(null, "", location.pathname + location.search);
    showApp();
  });

  ledgerDrawer.addEventListener("click", (event) => {
    if (event.target.closest("[data-drawer-close]")) closeLedger();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !ledgerDrawer.hidden) closeLedger();
  });
}

// ---------------------------------------------------------------------------
// Upload panel
// ---------------------------------------------------------------------------
// One or more chosen PDFs. A single file keeps the original single-upload flow
// (optional title field). Two or more become a bulk: each book's title defaults
// from its filename, and they share one bulkId when submitted.
let selectedFiles = [];

// Concurrency ceiling for every bounded loop in a bulk run (upload, count, and
// start). Ten at a time keeps a large group moving without hammering the worker.
const BULK_CONCURRENCY = 10;

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

// A filename minus its .pdf extension, used as the default per-book title.
function titleFromFilename(name) {
  return (name || "").replace(/\.pdf$/i, "").trim();
}

function selectedMode() {
  const checked = document.querySelector('input[name="job-mode"]:checked');
  return checked ? checked.value : "reflow";
}

function selectedEnrich() {
  return enrichAvailable && !!enrichToggle && enrichToggle.checked;
}

function updateRateNote() {
  const rate = RATES[selectedMode()] + (selectedEnrich() ? enrichRate : 0);
  ratePerPage.textContent = rate.toFixed(1);
}

// Reflect server config in the upload form: show the emphasis checkbox and its
// price only when the add-on is available.
async function applyAppConfig() {
  const cfg = await getAppConfig();
  const en = cfg && cfg.enrich;
  enrichAvailable = !!(en && en.available);
  if (en && typeof en.rateCredits === "number" && en.rateCredits > 0) {
    enrichRate = en.rateCredits;
  }
  if (enrichPrice) enrichPrice.textContent = enrichRate.toFixed(1);
  if (enrichField) enrichField.hidden = !enrichAvailable;
  updateRateNote();
}

function showUploadStatus(message, kind) {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("upload-status--error", kind === "error");
  uploadStatus.hidden = false;
}

function hideUploadStatus() {
  uploadStatus.hidden = true;
}

// Add newly chosen PDFs to the selection, skipping non-PDFs and files already
// picked (matched loosely by name + size). Then repaint the drop zone.
function addFiles(fileList) {
  const incoming = Array.from(fileList || []);
  if (incoming.length === 0) return;

  let rejected = 0;
  for (const file of incoming) {
    const looksPdf =
      file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
    if (!looksPdf) {
      rejected += 1;
      continue;
    }
    const already = selectedFiles.some(
      (f) => f.name === file.name && f.size === file.size
    );
    if (!already) selectedFiles.push(file);
  }

  if (rejected > 0 && selectedFiles.length === 0) {
    showUploadStatus("Those do not look like PDFs. We read scanned PDFs only, for now.", "error");
  } else if (rejected > 0) {
    showUploadStatus(
      rejected === 1
        ? "One file was not a PDF, so we left it out."
        : `${rejected} files were not PDFs, so we left them out.`,
      "error"
    );
  } else {
    hideUploadStatus();
  }
  renderSelection();
}

function removeFileAt(index) {
  selectedFiles.splice(index, 1);
  renderSelection();
}

function clearFiles() {
  selectedFiles = [];
  fileInput.value = "";
  renderSelection();
}

// Paints the drop zone, the queue list, and the title field to match the
// current selection. Single file: original single-file look, title field on.
// Two or more: the queue list appears and the title field hides.
function renderSelection() {
  const count = selectedFiles.length;
  const isBulk = count >= 2;

  dropZone.classList.toggle("has-file", count === 1);
  if (count === 1) {
    const file = selectedFiles[0];
    dropZoneLine.hidden = true;
    dropZoneFile.hidden = false;
    dropZoneFile.textContent = `${file.name}  ·  ${formatSize(file.size)}`;
  } else {
    dropZoneLine.hidden = false;
    dropZoneFile.hidden = true;
    dropZoneFile.textContent = "";
  }

  titleField.hidden = isBulk;
  queueList.hidden = !isBulk;
  if (isBulk) {
    queueCount.textContent = `${count} books ready to convert`;
    queueFiles.replaceChildren();
    selectedFiles.forEach((file, index) => {
      const item = el("li", "queue__file");
      const info = el("div", "queue__info");
      info.appendChild(el("span", "queue__name", titleFromFilename(file.name) || file.name));
      info.appendChild(el("span", "queue__size", formatSize(file.size)));
      item.appendChild(info);

      const remove = el("button", "queue__remove");
      remove.type = "button";
      remove.setAttribute("aria-label", `Remove ${file.name}`);
      remove.innerHTML =
        '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" ' +
        'stroke-width="1.7" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';
      remove.addEventListener("click", () => removeFileAt(index));
      item.appendChild(remove);

      queueFiles.appendChild(item);
    });
  }
}

function showUploadProgress(done, total) {
  uploadProgress.hidden = false;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  uploadProgressBar.style.width = `${pct}%`;
  uploadProgressText.textContent = `Uploading ${Math.min(done + 1, total)} of ${total}...`;
}

function hideUploadProgress() {
  uploadProgress.hidden = true;
  uploadProgressBar.style.width = "0%";
}

// Public config (whether direct-to-R2 uploads are active), fetched once.
let _appConfig = null;
async function getAppConfig() {
  if (!_appConfig) {
    try {
      _appConfig = await (await fetch("/api/config")).json();
    } catch {
      _appConfig = { r2Direct: false };
    }
  }
  return _appConfig;
}

// Create a job and upload one PDF's bytes to R2, without starting it. This is
// the reusable upload half: the single-file flow starts the job right after,
// and the bulk flow uploads everything first, counts pages, then starts only
// what the reader can afford. Returns the created job (with its id).
async function createAndUpload(file, mode, bulkId) {
  const params = new URLSearchParams({ mode });
  const title = bulkId ? titleFromFilename(file.name) : jobTitle.value.trim();
  if (title) params.set("title", title);
  if (bulkId) params.set("bulk", bulkId);
  // One checkbox governs the whole submission; read it at upload time.
  if (selectedEnrich()) params.set("enrich", "1");

  const cfg = await getAppConfig();
  let job;
  if (cfg.r2Direct) {
    // Direct to R2: get a presigned URL and a job, then PUT the file straight to
    // R2 so the bytes never pass through the app.
    params.set("direct", "1");
    job = await api(`/api/jobs?${params.toString()}`, { method: "POST" });
    const put = await fetch(job.uploadUrl, { method: "PUT", body: file });
    if (!put.ok) throw Object.assign(new Error("upload to storage failed"), { status: put.status });
  } else {
    // Streaming fallback: the app streams the body to R2 without buffering.
    job = await api(`/api/jobs?${params.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: file,
    });
  }
  return job;
}

// Single-file flow: upload, then start in the same step (count folds into
// start server-side). Returns { ok } on success, or { stop } with a warm
// message when the balance runs out (402).
async function uploadOne(file, mode) {
  const job = await createAndUpload(file, mode, null);
  try {
    await api(`/api/jobs/${job.id}/start`, { method: "POST" });
    return { ok: true };
  } catch (err) {
    if (err.status === 402) {
      const balance =
        currentBalance == null ? "" : ` Your balance is ${currentBalance.toFixed(1)} credits.`;
      return { stop: true, message: `${sentence(err.message)}.${balance}` };
    }
    throw err;
  }
}

// Run an async task over items with a bounded number in flight at once. A shared
// cursor hands each worker the next item; workers stop early when shouldStop()
// returns true (used to halt starts the moment a 402 lands). Every item passes
// through, so callers get one result per item in original order.
async function runPool(items, limit, task, shouldStop) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      if (shouldStop && shouldStop()) return;
      const index = cursor;
      if (index >= items.length) return;
      cursor += 1;
      results[index] = await task(items[index], index);
    }
  }
  const workers = [];
  for (let i = 0; i < Math.min(limit, items.length); i += 1) workers.push(worker());
  await Promise.all(workers);
  return results;
}

// ---------------------------------------------------------------------------
// Bulk panel: one warm card that walks the group through counting, the
// affordability gate, and the "how many left" indicator. Only one block shows
// at a time. Every string is sentence case and shows a clear count.
// ---------------------------------------------------------------------------
function showBulkPanel() {
  bulkPanel.hidden = false;
  // Focus the left column on the group panel: hide the upload form controls so
  // there is only one call to action (the gate's), not a stray "Create my edition".
  bulkPanel.closest(".panel--upload")?.classList.add("is-busy");
}
function hideBulkPanel() {
  bulkPanel.hidden = true;
  bulkPanel.closest(".panel--upload")?.classList.remove("is-busy");
  bulkCounting.hidden = true;
  bulkGate.hidden = true;
  bulkProcessing.hidden = true;
  bulkCountNote.hidden = true;
  bulkProcNote.hidden = true;
}

// "Counting pages... X of N", with a live bar. `unreadable` (once known) is
// surfaced as a calm aside so the reader knows a file was set aside.
function showCounting(done, total, unreadable) {
  showBulkPanel();
  bulkCounting.hidden = false;
  bulkGate.hidden = true;
  bulkProcessing.hidden = true;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  bulkCountBar.style.width = `${pct}%`;
  bulkCountBar.classList.toggle("bulk-panel__bar--live", done < total);
  bulkCountText.textContent =
    done >= total ? "Counting pages... done" : `Counting pages... ${done} of ${total}`;
  if (unreadable > 0) {
    bulkCountNote.hidden = false;
    bulkCountNote.textContent =
      unreadable === 1
        ? "1 file could not be read, so we left it out of the count."
        : `${unreadable} files could not be read, so we left them out of the count.`;
  } else {
    bulkCountNote.hidden = true;
  }
}

// "Processed X of N ... Y remaining", driven by the jobs list during phase B.
function showProcessing(processed, total, note) {
  showBulkPanel();
  bulkCounting.hidden = true;
  bulkGate.hidden = true;
  bulkProcessing.hidden = false;
  const remaining = Math.max(0, total - processed);
  const pct = total === 0 ? 0 : Math.round((processed / total) * 100);
  bulkProcBar.style.width = `${pct}%`;
  bulkProcBar.classList.toggle("bulk-panel__bar--live", remaining > 0);
  bulkProcText.textContent =
    remaining === 0
      ? `All ${total} ${total === 1 ? "book is" : "books are"} in.`
      : `Processed ${processed} of ${total}  ·  ${remaining} remaining`;
  if (note) {
    bulkProcNote.hidden = false;
    bulkProcNote.textContent = note;
  } else {
    bulkProcNote.hidden = true;
  }
}

function pluralBooks(n) {
  return n === 1 ? "1 book" : `${n} books`;
}
function pluralPages(n) {
  return n === 1 ? "1 page" : `${n} pages`;
}
function creditsWord(n) {
  const rounded = Math.round(n * 10) / 10;
  return `${rounded.toFixed(1)} ${rounded === 1 ? "credit" : "credits"}`;
}

async function submitUpload() {
  hideUploadStatus();
  if (selectedFiles.length === 0) {
    showUploadStatus("Choose a PDF first, then we can begin.", "error");
    return;
  }

  const files = selectedFiles.slice();
  const mode = selectedMode();
  const isBulk = files.length >= 2;

  // Single file keeps the original, quieter one-step flow (no progress bar,
  // count folds into start server-side).
  if (!isBulk) {
    uploadButton.disabled = true;
    const restLabel = uploadButton.textContent;
    uploadButton.textContent = "Uploading your scan...";
    try {
      const result = await uploadOne(files[0], mode);
      if (result.stop) {
        showUploadStatus(result.message, "error");
      } else {
        showUploadStatus("Your scan is in. We are reading the pages now.");
        clearFiles();
        jobTitle.value = "";
      }
    } catch (err) {
      // 400, 402 (from POST /jobs), 413 arrive here with the server's envelope.
      showUploadStatus(`${sentence(err.message)}.`, "error");
    } finally {
      await refreshJobs();
      await refreshMe();
      uploadButton.disabled = false;
      uploadButton.textContent = restLabel;
    }
    return;
  }

  await runBulk(files, mode);
}

// ---------------------------------------------------------------------------
// Bulk, two phases with a gate between them.
//
//   Phase A  upload every file, then count pages per job (no charge).
//   Gate     sum the credits needed, fetch the balance, and let the reader
//            choose: process the whole group, process only what fits, or stop.
//   Phase B  start the chosen books (each places its hold), then poll the jobs
//            list and show how many are left.
//
// The reader is never silently over-charged: nothing is started until they
// pick, and even then the atomic hold on the server is the real backstop.
// ---------------------------------------------------------------------------
async function runBulk(files, mode) {
  const bulkId = crypto.randomUUID();
  const total = files.length;

  uploadButton.disabled = true;
  const restLabel = uploadButton.textContent;
  uploadButton.textContent = "Uploading your books...";
  hideBulkPanel();

  // ---- Phase A.1: upload every file to R2 (create job, no start) -----------
  showUploadProgress(0, total);
  let uploaded = 0;
  const uploads = await runPool(files, BULK_CONCURRENCY, async (file) => {
    try {
      const job = await createAndUpload(file, mode, bulkId);
      return { job, title: titleFromFilename(file.name) || file.name };
    } catch (err) {
      console.error("bulk upload failed for a book", err);
      return { failed: true };
    } finally {
      uploaded += 1;
      showUploadProgress(uploaded, total);
    }
  });
  hideUploadProgress();

  const created = uploads.filter((u) => u && u.job);
  if (created.length === 0) {
    hideBulkPanel();
    showUploadStatus("We could not upload these books. Try again in a moment.", "error");
    uploadButton.disabled = false;
    uploadButton.textContent = restLabel;
    return;
  }

  // ---- Phase A.2: count pages per uploaded job (no charge) -----------------
  let counted = 0;
  let unreadable = uploads.length - created.length; // upload failures count as unreadable
  let totalPages = 0;
  let totalCredits = 0;
  const countTotal = created.length;
  showCounting(0, countTotal, unreadable);

  const priced = await runPool(created, BULK_CONCURRENCY, async (entry) => {
    try {
      const res = await api(`/api/jobs/${entry.job.id}/count`, { method: "POST" });
      totalPages += res.pageCount || 0;
      totalCredits += res.creditsNeeded || 0;
      return { ...entry, pageCount: res.pageCount, creditsNeeded: res.creditsNeeded };
    } catch (err) {
      // A bad file (4xx) or engine failure: record it and leave it out of the total.
      console.error("bulk count failed for a book", err);
      unreadable += 1;
      return null;
    } finally {
      counted += 1;
      showCounting(counted, countTotal, unreadable);
    }
  });

  const countable = priced.filter(Boolean);
  if (countable.length === 0) {
    hideBulkPanel();
    showUploadStatus(
      "None of these files could be read, so there is nothing to process.",
      "error"
    );
    await refreshJobs();
    uploadButton.disabled = false;
    uploadButton.textContent = restLabel;
    return;
  }

  // ---- Gate: fetch balance, then let the reader choose ---------------------
  let balance = currentBalance;
  try {
    const me = await api("/api/me");
    renderMe(me);
    balance = me.balance;
  } catch (err) {
    console.error("could not refresh balance before the gate", err);
    balance = currentBalance == null ? 0 : currentBalance;
  }

  await refreshJobs(); // the uploaded books now show as received in the list
  presentGate(countable, totalPages, totalCredits, balance, unreadable, restLabel);
}

// The affordability gate. Shows the summary and, depending on whether the
// group fits the balance, either a single "process these books" button or a warm
// shortfall message with a "process what fits" fallback. Wires the buttons to
// phase B and always offers a plain way out.
function presentGate(countable, totalPages, totalCredits, balance, unreadable, restLabel) {
  uploadButton.disabled = false;
  uploadButton.textContent = restLabel;

  showBulkPanel();
  bulkCounting.hidden = true;
  bulkProcessing.hidden = true;
  bulkGate.hidden = false;

  const affords = totalCredits <= balance + 1e-9;
  const books = countable.length;

  bulkGateSummary.textContent =
    `${pluralBooks(books)}, ${pluralPages(totalPages)}, ${creditsWord(totalCredits)} needed.`;
  bulkGateBalance.textContent = `You have ${creditsWord(balance)}.`;

  // How many books, in creation order, fit inside the balance.
  let fitCredits = 0;
  let fitCount = 0;
  for (const entry of countable) {
    if (fitCredits + entry.creditsNeeded <= balance + 1e-9) {
      fitCredits += entry.creditsNeeded;
      fitCount += 1;
    } else {
      break;
    }
  }

  // Reset action buttons.
  bulkProcessAll.hidden = true;
  bulkProcessFits.hidden = true;
  bulkGateMessage.hidden = true;
  bulkProcessAll.onclick = null;
  bulkProcessFits.onclick = null;

  if (affords) {
    bulkProcessAll.hidden = false;
    bulkProcessAll.textContent = `Process ${pluralBooks(books)}`;
    bulkProcessAll.onclick = () => startChosen(countable, restLabel);
  } else {
    bulkGateMessage.hidden = false;
    bulkGateMessage.textContent =
      `This group needs ${creditsWord(totalCredits)} but you have ${creditsWord(balance)}. ` +
      `Remove some books or add credits.`;
    if (fitCount > 0) {
      bulkProcessFits.hidden = false;
      bulkProcessFits.textContent =
        `Process what fits (${pluralBooks(fitCount)}, ${creditsWord(fitCredits)})`;
      bulkProcessFits.onclick = () => startChosen(countable.slice(0, fitCount), restLabel);
    }
  }

  bulkCancel.onclick = () => {
    hideBulkPanel();
    showUploadStatus(
      "Nothing was started, so no credits were used. Your uploaded books are waiting for credits.",
      "error"
    );
  };
}

// Phase B: start the chosen books with bounded concurrency, then poll the jobs
// list and show how many are left. A 402 on any start (a race against another
// tab) stops launching more and surfaces the warm shortfall message.
async function startChosen(chosen, restLabel) {
  const total = chosen.length;
  bulkProcessAll.disabled = true;
  bulkProcessFits.disabled = true;

  // Only the books that actually started drive the remaining indicator, so the
  // count stays exact even if a 402 stops the launch partway.
  const startedIds = new Set();
  let raced = null; // warm message if a 402 lands mid-launch

  await runPool(
    chosen,
    BULK_CONCURRENCY,
    async (entry) => {
      try {
        await api(`/api/jobs/${entry.job.id}/start`, { method: "POST" });
        startedIds.add(entry.job.id);
      } catch (err) {
        if (err.status === 402 && !raced) {
          raced = `We ran out of credits partway through. ${startedIds.size} of ${total} started; the rest are waiting for credits.`;
        } else if (err.status !== 402) {
          console.error("bulk start failed for a book", err);
        }
      }
    },
    () => raced != null
  );

  bulkProcessAll.disabled = false;
  bulkProcessFits.disabled = false;

  if (startedIds.size === 0) {
    // Nothing started (every start raced to a 402): keep the gate out of the
    // way and surface the warm shortfall, uncharged.
    bulkStartedIds = null;
    bulkStartedCount = 0;
    hideBulkPanel();
    showUploadStatus(
      raced || "We could not start these books. They are waiting for credits.",
      "error"
    );
    await refreshMe();
    await refreshJobs();
    return;
  }

  // Move to the remaining indicator and let polling drive it from here.
  bulkStartedIds = startedIds;
  bulkStartedCount = startedIds.size;
  showProcessing(0, startedIds.size, raced);
  hideUploadStatus();

  await refreshMe();
  await refreshJobs(); // renders the bulk card and schedules polling
}

// Ids the reader started in this session's bulk run, and how many. While these
// are still being read, the jobs poll updates the remaining indicator; once all
// are terminal, the indicator settles and stops leading.
let bulkStartedIds = null;
let bulkStartedCount = 0;

// Called after each jobs refresh: if a bulk run is in flight, count how many of
// the started books have reached a terminal state and update the indicator.
function updateProcessingIndicator(jobs) {
  if (!bulkStartedIds || bulkStartedCount === 0) return;
  const mine = jobs.filter((j) => bulkStartedIds.has(j.id));
  const done = mine.filter((j) => TERMINAL_STATUSES.has(j.status)).length;
  showProcessing(done, bulkStartedCount);
  if (done >= bulkStartedCount) {
    // Everything settled: clear the run so the indicator stops leading, and
    // clear the file selection now that the group is fully in.
    bulkStartedIds = null;
    bulkStartedCount = 0;
    clearFiles();
  }
}

function wireUploadPanel() {
  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      fileInput.click();
    }
  });
  fileInput.addEventListener("change", () => addFiles(fileInput.files));

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-drag");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-drag"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-drag");
    addFiles(event.dataTransfer?.files);
  });

  queueClear.addEventListener("click", clearFiles);

  for (const radio of document.querySelectorAll('input[name="job-mode"]')) {
    radio.addEventListener("change", updateRateNote);
  }
  if (enrichToggle) enrichToggle.addEventListener("change", updateRateNote);
  updateRateNote();
  applyAppConfig().catch((err) => console.error("config load failed", err));

  uploadButton.addEventListener("click", () => {
    submitUpload().catch((err) => console.error("upload failed", err));
  });
}

// ---------------------------------------------------------------------------
// Translate view. Hidden unless /api/me carries the translate terms (the
// backend enables it per reader). Paste text or pick a ready edition, choose
// a language, see the live price, and read the result in a drawer.
// ---------------------------------------------------------------------------
const LANGUAGE_GROUPS = [
  ["English", ["English"]],
  ["Indian languages", [
    "Assamese", "Bengali", "Bodo", "Dogri", "Gujarati", "Hindi", "Kannada",
    "Kashmiri", "Konkani", "Maithili", "Malayalam", "Manipuri", "Marathi",
    "Nepali", "Odia", "Punjabi", "Sanskrit", "Santali", "Sindhi", "Tamil",
    "Telugu", "Urdu",
  ]],
  ["Wider South Asia", [
    "Awadhi", "Balochi", "Bhojpuri", "Brahui", "Chhattisgarhi", "Dari",
    "Dhivehi", "Dzongkha", "Garo", "Haryanvi", "Khasi", "Magahi", "Mizo",
    "Pashto", "Rajasthani", "Sinhala", "Tulu",
  ]],
  ["World languages", [
    "Arabic", "Bahasa Indonesia", "Bahasa Malaysia", "Burmese",
    "Chinese (Simplified)", "Chinese (Traditional)", "Czech", "Danish",
    "Dutch", "Filipino", "Finnish", "French", "German", "Greek", "Hebrew",
    "Hungarian", "Italian", "Japanese", "Khmer", "Korean", "Lao", "Norwegian",
    "Persian", "Polish", "Portuguese", "Romanian", "Russian", "Spanish",
    "Swahili", "Swedish", "Thai", "Turkish", "Ukrainian", "Vietnamese",
  ]],
];

const TRANSLATION_STATUS_LABELS = {
  received: "Received",
  processing: "Translating",
  ready: "Ready",
  failed: "Failed",
};

let translateSource = "text"; // "text" | "book"
let bookQuote = null;          // last server quote for the selected book
let translatePollTimer = null;

function stopTranslatePolling() {
  if (translatePollTimer) {
    clearTimeout(translatePollTimer);
    translatePollTimer = null;
  }
}

function populateLanguages() {
  if (translateLanguage.options.length > 0) return;
  for (const [group, langs] of LANGUAGE_GROUPS) {
    const og = document.createElement("optgroup");
    og.label = group;
    for (const lang of langs) {
      const opt = document.createElement("option");
      opt.value = lang;
      opt.textContent = lang;
      og.appendChild(opt);
    }
    translateLanguage.appendChild(og);
  }
  translateLanguage.value = "Hindi";
}

// Price in credits for a word count, mirroring the server's rounding: prorated
// per word, rounded half up to two decimal places of a credit.
function translateCreditsFor(words) {
  if (!sessionTranslate) return 0;
  const mcr = Math.round(
    (words * sessionTranslate.blockCredits * 1000) / sessionTranslate.blockWords / 10
  ) * 10;
  return mcr / 1000;
}

// A quick local word count for the live note while typing. The server's count
// (which ignores markdown syntax) is the one that is billed, so this reads as
// "about". CJK scripts count per character, like the server.
function localWordCount(text) {
  const cjk = (text.match(/[぀-ヿ㐀-䶿一-鿿가-힯]/g) || []).length;
  const rest = text
    .replace(/[぀-ヿ㐀-䶿一-鿿가-힯]/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean).length;
  return rest + cjk;
}

function setTranslateTab(which) {
  translateSource = which;
  trTabText.classList.toggle("is-active", which === "text");
  trTabBook.classList.toggle("is-active", which === "book");
  trTabText.setAttribute("aria-selected", which === "text" ? "true" : "false");
  trTabBook.setAttribute("aria-selected", which === "book" ? "true" : "false");
  translateTextField.hidden = which !== "text";
  translateBookField.hidden = which !== "book";
  updateTranslatePrice();
}

function updateTranslatePrice() {
  if (!sessionTranslate) return;
  const max = sessionTranslate.maxWords;
  let words = null;
  let about = false;
  if (translateSource === "text") {
    const text = translateText.value;
    words = text.trim() ? localWordCount(text) : 0;
    about = true;
  } else if (bookQuote) {
    words = bookQuote.words;
  }
  translateButton.disabled = false;
  if (words == null || words === 0) {
    translatePrice.textContent =
      `500 credits per 350 words, up to ${max.toLocaleString("en")} words at a time.`;
    return;
  }
  const price = translateCreditsFor(words).toFixed(2);
  if (words > max) {
    translatePrice.textContent =
      `Sorry, that is not possible right now: this is ${about ? "about " : ""}` +
      `${words.toLocaleString("en")} words, and translations are capped at ` +
      `${max.toLocaleString("en")} words for now.`;
    translateButton.disabled = true;
    return;
  }
  translatePrice.textContent =
    `${about ? "About " : ""}${words.toLocaleString("en")} words, ` +
    `${price} credits.`;
}

function showTranslateStatus(message, kind) {
  translateStatus.textContent = message;
  translateStatus.classList.toggle("upload-status--error", kind === "error");
  translateStatus.hidden = false;
}

// Ready editions for the "one of your books" source.
async function populateBookChoices() {
  let jobs = [];
  try {
    const data = previewFixtures ? { jobs: FIXTURE_JOBS } : await api("/api/jobs");
    jobs = (data.jobs || []).filter((j) => j.status === "ready");
  } catch (err) {
    console.error("failed to load editions for translate", err);
  }
  const current = translateBook.value;
  translateBook.replaceChildren();
  const first = document.createElement("option");
  first.value = "";
  first.textContent = jobs.length ? "Choose a finished edition" : "No finished editions yet";
  translateBook.appendChild(first);
  for (const job of jobs) {
    const opt = document.createElement("option");
    opt.value = job.id;
    opt.textContent = job.title || "Untitled scan";
    translateBook.appendChild(opt);
  }
  if (current && jobs.some((j) => j.id === current)) translateBook.value = current;
}

async function quoteSelectedBook() {
  bookQuote = null;
  updateTranslatePrice();
  const jobId = translateBook.value;
  if (!jobId || previewFixtures) return;
  translatePrice.textContent = "Counting the words...";
  try {
    bookQuote = await api("/api/translate/quote", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "book", jobId }),
    });
  } catch (err) {
    console.error("quote failed", err);
    showTranslateStatus(`${sentence(err.message)}.`, "error");
  }
  updateTranslatePrice();
}

async function submitTranslation() {
  translateStatus.hidden = true;
  const targetLanguage = translateLanguage.value;
  let body;
  if (translateSource === "text") {
    const text = translateText.value;
    if (!text.trim()) {
      showTranslateStatus("Paste some text first, then we can begin.", "error");
      return;
    }
    body = { kind: "text", text, targetLanguage };
  } else {
    const jobId = translateBook.value;
    if (!jobId) {
      showTranslateStatus("Choose a finished edition first.", "error");
      return;
    }
    body = { kind: "book", jobId, targetLanguage };
  }

  translateButton.disabled = true;
  const restLabel = translateButton.textContent;
  translateButton.textContent = "Starting...";
  try {
    const t = await api("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    showTranslateStatus(
      `Translating into ${t.targetLanguage}. ${Number(t.words).toLocaleString("en")} words, ` +
      `${Number(t.credits).toFixed(2)} credits held.`
    );
    if (translateSource === "text") translateText.value = "";
    bookQuote = null;
    updateTranslatePrice();
    await refreshTranslations();
    await refreshMe();
  } catch (err) {
    showTranslateStatus(`${sentence(err.message)}.`, "error");
  } finally {
    translateButton.disabled = false;
    translateButton.textContent = restLabel;
    updateTranslatePrice();
  }
}

function renderTranslationRow(t) {
  const row = el("article", "job");
  const main = el("div", "job__main");
  const label = t.kind === "book" ? (t.title || "Untitled scan") : "Pasted text";
  main.appendChild(el("h3", "job__title", `${label} into ${t.targetLanguage}`));

  const meta = [];
  if (t.words) meta.push(t.words === 1 ? "1 word" : `${Number(t.words).toLocaleString("en")} words`);
  if (t.credits != null) meta.push(`${Number(t.credits).toFixed(2)} credits`);
  const ago = timeAgo(t.createdAt);
  if (ago) meta.push(ago);
  main.appendChild(el("p", "job__meta", meta.join("  ·  ")));

  if (t.status === "failed" && t.error) {
    main.appendChild(el("p", "job__error", sentence(t.error)));
  }

  if (t.status === "ready") {
    const wrap = el("div", "downloads");
    const readBtn = el("button", "download-btn", "Read");
    readBtn.type = "button";
    readBtn.addEventListener("click", () => openTranslation(t));
    wrap.appendChild(readBtn);
    const formats = t.kind === "book"
      ? [["md", "Markdown"], ["epub", "EPUB"], ["docx", "Word"]]
      : [["md", "Markdown"]];
    for (const [format, label2] of formats) {
      const btn = el("button", "download-btn", label2);
      btn.type = "button";
      btn.addEventListener("click", () => downloadTranslation(t, format, btn));
      wrap.appendChild(btn);
    }
    main.appendChild(wrap);
  }
  row.appendChild(main);

  const chip = el("span", `status ${statusClass(t.status)}`.trim());
  chip.appendChild(el("span", "status__dot"));
  chip.appendChild(document.createTextNode(TRANSLATION_STATUS_LABELS[t.status] || t.status));
  row.appendChild(chip);
  return row;
}

function renderTranslations(list) {
  translationsList.replaceChildren();
  if (list.length === 0) {
    translationsCount.hidden = true;
    const empty = el("div", "empty");
    empty.appendChild(el("h3", "empty__title", "Your first translation goes here."));
    empty.appendChild(el("p", "empty__body",
      "Paste some text or pick a finished edition, choose a language, and the result keeps the original structure."));
    translationsList.appendChild(empty);
  } else {
    translationsCount.hidden = false;
    translationsCount.textContent =
      list.length === 1 ? "1 translation" : `${list.length} translations`;
    for (const t of list) translationsList.appendChild(renderTranslationRow(t));
  }
  stopTranslatePolling();
  if (previewFixtures) return;
  if (list.some((t) => t.status === "received" || t.status === "processing")) {
    translatePollTimer = setTimeout(async () => {
      translatePollTimer = null;
      try {
        await refreshTranslations();
        await refreshMe();
      } catch (err) {
        console.error("translation poll failed", err);
      }
    }, 5_000);
  }
}

async function refreshTranslations() {
  if (previewFixtures) {
    renderTranslations(FIXTURE_TRANSLATIONS);
    return;
  }
  const data = await api("/api/translate");
  renderTranslations(data.translations || []);
}

async function loadTranslateData() {
  populateLanguages();
  updateTranslatePrice();
  try {
    await Promise.all([refreshTranslations(), populateBookChoices()]);
  } catch (err) {
    console.error("failed to load translations", err);
  }
}

async function openTranslation(t) {
  translationSub.textContent =
    `${t.kind === "book" ? (t.title || "Untitled scan") : "Pasted text"} into ${t.targetLanguage}`;
  translationTextBody.textContent = "Loading...";
  translationDownloads.replaceChildren();
  translationDrawer.hidden = false;
  document.body.style.overflow = "hidden";
  translationClose.focus();
  try {
    const data = previewFixtures
      ? { markdown: FIXTURE_TRANSLATION_MD }
      : await api(`/api/translate/${t.id}/result`);
    translationTextBody.textContent = data.markdown || "";
  } catch (err) {
    console.error("failed to load translation", err);
    translationTextBody.textContent = "We could not load this translation. Try again in a moment.";
  }
}

function closeTranslation() {
  translationDrawer.hidden = true;
  document.body.style.overflow = "";
}

// Same bearer + blob dance as edition downloads: a plain link cannot carry
// the token, and md may answer with a 302 to storage.
async function downloadTranslation(t, format, button) {
  button.disabled = true;
  const restLabel = button.textContent;
  button.textContent = "Preparing...";
  try {
    const token = await getToken();
    const headers = new Headers();
    if (token) headers.set("Authorization", `Bearer ${token}`);
    const response = await fetch(
      `/api/translate/${t.id}/download?format=${format}`,
      { headers, redirect: "follow" }
    );
    if (!response.ok) throw new Error(`request failed (${response.status})`);
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    const base = (t.title || t.targetLanguage || "translation")
      .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "translation";
    anchor.download = `${base}.${format}`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    console.error("translation download failed", err);
  } finally {
    button.disabled = false;
    button.textContent = restLabel;
  }
}

function wireTranslatePanel() {
  trTabText.addEventListener("click", () => setTranslateTab("text"));
  trTabBook.addEventListener("click", () => setTranslateTab("book"));
  translateText.addEventListener("input", updateTranslatePrice);
  translateBook.addEventListener("change", () => {
    quoteSelectedBook().catch((err) => console.error("quote failed", err));
  });
  translateButton.addEventListener("click", () => {
    submitTranslation().catch((err) => console.error("translate failed", err));
  });
  translateBackLink.addEventListener("click", (event) => {
    event.preventDefault();
    history.replaceState(null, "", location.pathname + location.search);
    showApp();
  });
  translateSignOutButton.addEventListener("click", async () => {
    try {
      await signOutUser();
    } catch (err) {
      console.error("sign out failed", err);
    }
  });
  translationDrawer.addEventListener("click", (event) => {
    if (event.target.closest("[data-translation-close]")) closeTranslation();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !translationDrawer.hidden) closeTranslation();
  });
}

// Fixture data for the visual pass (`?preview-fixtures=translate`).
const FIXTURE_TRANSLATIONS = [
  { id: "ft-1", kind: "text", jobId: null, targetLanguage: "Hindi", status: "processing",
    title: null, words: 355, credits: 507.14, error: null, createdAt: agoIso(40 * 1000) },
  { id: "ft-2", kind: "book", jobId: "fx-b2", targetLanguage: "Urdu", status: "ready",
    title: "The Deccan Sultanates", words: 1840, credits: 2628.57, error: null,
    createdAt: agoIso(50 * 60 * 1000) },
  { id: "ft-3", kind: "text", jobId: null, targetLanguage: "Tamil", status: "failed",
    title: null, words: 620, credits: 885.71,
    error: "something went wrong while translating, your credits were not charged",
    createdAt: agoIso(3 * 60 * 60 * 1000) },
];

const FIXTURE_TRANSLATION_MD =
  "# دکن کی سلطنتیں\n\nیہ ایک نمونہ ترجمہ ہے۔ اصل ساخت جوں کی توں رہتی ہے۔\n";

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function loadAppData() {
  try {
    await Promise.all([refreshMe(), refreshJobs()]);
  } catch (err) {
    console.error("failed to load account data", err);
  }
}

function wireLoginActions() {
  googleButton?.addEventListener("click", async () => {
    try {
      await signInWithGoogle();
    } catch (err) {
      console.error("google sign in failed", err);
    }
  });

  magicLinkButton?.addEventListener("click", async () => {
    const email = magicLinkEmail?.value.trim();
    if (!email) return;
    try {
      await sendMagicLink(email);
      if (magicLinkStatus) {
        magicLinkStatus.hidden = false;
        magicLinkStatus.textContent = "Check your inbox. The link signs you in on this device.";
      }
    } catch (err) {
      console.error("failed to send sign in link", err);
    }
  });

  signOutButton?.addEventListener("click", async () => {
    try {
      await signOutUser();
    } catch (err) {
      console.error("sign out failed", err);
    }
  });
}

// Localhost fixtures for the two-phase bulk panel, so each state can be
// screenshotted without a backend. `?preview-fixtures=<state>`:
//   counting     the "counting pages X of N" indicator, mid-count
//   gate-ok      the affordability gate when the group fits
//   gate-over    the gate when the group is over budget (with "process what fits")
//   processing   the "processed X of N, Y remaining" indicator, mid-run
//   waiting      the group card after "process what fits" (some waiting for credits)
// Any other value (or the plain flag) leaves the panel hidden.
function renderBulkFixture() {
  const q = location.search;
  const at = (key) => q.includes(`preview-fixtures=${key}`);

  if (at("counting")) {
    showCounting(6, 14, 1);
  } else if (at("gate-ok")) {
    presentGate(
      Array.from({ length: 12 }, (_, i) => ({ job: { id: `fx-c${i}` }, creditsNeeded: 20 })),
      2680, 22.9, 42.7, 0, "Create my edition"
    );
  } else if (at("gate-over")) {
    // Nine books at ~9 credits each = ~81 needed against a 42.7 balance; the
    // first four fit inside the balance.
    const books = Array.from({ length: 9 }, (_, i) => ({
      job: { id: `fx-o${i}` }, creditsNeeded: 9,
    }));
    presentGate(books, 900, 81, 42.7, 1, "Create my edition");
  } else if (at("processing")) {
    showProcessing(4, 12);
  }
}

async function boot() {
  wireLoginActions();
  wireUploadPanel();
  wireAdminPanel();
  wireTranslatePanel();

  // Hash routing lives across every signed in view; only #admin (and only for
  // admins) reaches the admin view.
  window.addEventListener("hashchange", routeHash);

  if (previewFixtures) {
    // Visual pass only: canned data, no auth, no polling. See the note above.
    // `?preview-fixtures=admin` opens straight on the admin view; the plain
    // flag stays on the app shell as before, and `=empty` shows the empty jobs
    // list. The bulk states below drive the two-phase panel from fixture data
    // so each can be screenshotted without a backend. No real API is ever hit.
    renderMe(FIXTURE_ME);
    userEmail.textContent = FIXTURE_ME.email;
    let fixtureJobs = FIXTURE_JOBS;
    if (location.search.includes("preview-fixtures=empty")) fixtureJobs = [];
    else if (location.search.includes("preview-fixtures=waiting")) fixtureJobs = FIXTURE_JOBS_WAITING;
    renderJobs(fixtureJobs);
    sessionReady = true;
    if (location.search.includes("preview-fixtures=admin")) {
      renderUsers(FIXTURE_USERS);
      showAdmin();
    } else if (location.search.includes("preview-fixtures=translate")) {
      populateLanguages();
      updateTranslatePrice();
      renderTranslations(FIXTURE_TRANSLATIONS);
      populateBookChoices();
      showTranslate();
    } else {
      showApp();
      renderBulkFixture();
    }
    return;
  }

  try {
    await completeMagicLink();
  } catch (err) {
    console.error("failed to complete magic link sign in", err);
  }

  initAuth((user) => {
    if (user) {
      if (userEmail) {
        userEmail.textContent = user.email || "";
      }
      showApp();
      loadAppData().then(() => {
        // Now that we know whether the user is an admin, honour a deep link to
        // #admin (or drop it if they are not an admin).
        sessionReady = true;
        routeHash();
      });
    } else {
      sessionReady = false;
      sessionIsAdmin = false;
      showLogin();
    }
  });
}

boot();
