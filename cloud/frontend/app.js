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
const uploadButton = document.getElementById("upload-button");
const uploadStatus = document.getElementById("upload-status");
const uploadProgress = document.getElementById("upload-progress");
const uploadProgressBar = document.getElementById("upload-progress-bar");
const uploadProgressText = document.getElementById("upload-progress-text");
const jobsList = document.getElementById("jobs-list");
const jobsCount = document.getElementById("jobs-count");

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
const RATES = { reflow: 0.9, fixed: 3.0 };

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
  stopPolling();
}

function showApp() {
  loginView.hidden = true;
  adminView.hidden = true;
  appView.hidden = false;
}

function showAdmin() {
  loginView.hidden = true;
  appView.hidden = true;
  adminView.hidden = false;
}

// Routes the current hash to a view. Only #admin, and only for admins with a
// live session, reaches the admin view; everything else falls back to the app.
function routeHash() {
  if (!sessionReady) return;
  if (location.hash === "#admin" && sessionIsAdmin) {
    showAdmin();
    loadAdminData();
  } else {
    if (location.hash === "#admin") {
      // non admin (or stale hash): drop it so the app view is clean
      history.replaceState(null, "", location.pathname + location.search);
    }
    showApp();
  }
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

function renderMe(me) {
  currentBalance = me.balance;
  balanceAmount.textContent = `${me.balance.toFixed(1)} credits`;
  balanceChip.hidden = false;
  sessionIsAdmin = !!me.isAdmin;
  adminLink.hidden = !me.isAdmin;
  if (me.email) {
    userEmail.textContent = me.email;
    adminEmail.textContent = me.email;
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
    const response = await fetch(
      `/api/jobs/${job.id}/download?format=${format}`,
      { headers }
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
  schedulePoll(jobs);
}

// One bulk card: a header summarising the group, then a book row per member.
function renderBulkGroup(group) {
  const members = group.jobs;
  const ready = members.filter((j) => j.status === "ready");
  const failed = members.filter((j) => j.status === "failed").length;
  const inProgress = members.filter((j) => !TERMINAL_STATUSES.has(j.status)).length;

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

  const chip = el("span", `status ${statusClass(job.status)}`.trim());
  chip.appendChild(el("span", "status__dot"));
  chip.appendChild(document.createTextNode(STATUS_LABELS[job.status] || job.status));
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

// Concurrency ceiling for bulk uploads: submit a few at a time rather than all
// at once, so a large group does not hammer the worker.
const BULK_CONCURRENCY = 3;

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

function updateRateNote() {
  ratePerPage.textContent = RATES[selectedMode()].toFixed(1);
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

// Upload one file: POST the bytes (optionally with a bulk id), then start it.
// Returns { ok } on success, or { stop } with a warm message when the balance
// runs out (402), so the caller can stop launching further books.
async function uploadOne(file, mode, bulkId) {
  const params = new URLSearchParams({ mode });
  const title = bulkId ? titleFromFilename(file.name) : jobTitle.value.trim();
  if (title) params.set("title", title);
  if (bulkId) params.set("bulk", bulkId);

  const job = await api(`/api/jobs?${params.toString()}`, {
    method: "POST",
    headers: { "content-type": "application/pdf" },
    body: file,
  });

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

async function submitUpload() {
  hideUploadStatus();
  if (selectedFiles.length === 0) {
    showUploadStatus("Choose a PDF first, then we can begin.", "error");
    return;
  }

  const files = selectedFiles.slice();
  const mode = selectedMode();
  const isBulk = files.length >= 2;
  const bulkId = isBulk ? crypto.randomUUID() : null;

  uploadButton.disabled = true;
  const restLabel = uploadButton.textContent;
  uploadButton.textContent = isBulk ? "Uploading your books..." : "Uploading your scan...";

  // Single file keeps the original, quieter flow (no progress bar).
  if (!isBulk) {
    try {
      const result = await uploadOne(files[0], mode, null);
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

  // Bulk: submit with bounded concurrency. A shared cursor hands each worker
  // the next file; the moment a 402 (or hard error) lands, we stop handing out
  // new files, so books already submitted keep going but no new ones start.
  let done = 0;
  let started = 0;
  let stopped = null; // set to the warm message when credits run out
  let hadError = false;
  let cursor = 0;
  const total = files.length;
  showUploadProgress(0, total);

  async function worker() {
    while (true) {
      if (stopped) return;
      const index = cursor;
      if (index >= total) return;
      cursor += 1;
      const file = files[index];
      try {
        const result = await uploadOne(file, mode, bulkId);
        if (result.stop) {
          stopped = result.message;
          return;
        }
        started += 1;
      } catch (err) {
        hadError = true;
        console.error("bulk upload failed for a book", err);
      } finally {
        done += 1;
        showUploadProgress(done, total);
      }
    }
  }

  const workers = [];
  for (let i = 0; i < Math.min(BULK_CONCURRENCY, total); i += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);

  hideUploadProgress();

  if (stopped) {
    const kept = started === 1 ? "1 book is on its way" : `${started} books are on their way`;
    showUploadStatus(`${stopped} ${kept}; the rest were not started.`, "error");
  } else if (hadError && started === 0) {
    showUploadStatus("We could not start these books. Try again in a moment.", "error");
  } else if (hadError) {
    showUploadStatus(
      `${started} of ${total} books are in. Some did not go through; try those again.`,
      "error"
    );
  } else {
    showUploadStatus(
      started === 1
        ? "Your book is in. We are reading the pages now."
        : `All ${started} books are in. We are reading the pages now.`
    );
    clearFiles();
  }

  await refreshJobs();
  await refreshMe();
  uploadButton.disabled = false;
  uploadButton.textContent = restLabel;
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
  updateRateNote();

  uploadButton.addEventListener("click", () => {
    submitUpload().catch((err) => console.error("upload failed", err));
  });
}

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

async function boot() {
  wireLoginActions();
  wireUploadPanel();
  wireAdminPanel();

  // Hash routing lives across every signed in view; only #admin (and only for
  // admins) reaches the admin view.
  window.addEventListener("hashchange", routeHash);

  if (previewFixtures) {
    // Visual pass only: canned data, no auth, no polling. See the note above.
    // `?preview-fixtures=admin` opens straight on the admin view; the plain
    // flag stays on the app shell as before, and `=empty` shows the empty jobs
    // list. Everything is fixture data; no real API is ever hit.
    renderMe(FIXTURE_ME);
    userEmail.textContent = FIXTURE_ME.email;
    renderJobs(location.search.includes("preview-fixtures=empty") ? [] : FIXTURE_JOBS);
    sessionReady = true;
    if (location.search.includes("preview-fixtures=admin")) {
      renderUsers(FIXTURE_USERS);
      showAdmin();
    } else {
      showApp();
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
