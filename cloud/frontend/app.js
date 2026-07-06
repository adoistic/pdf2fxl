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
const jobTitle = document.getElementById("job-title");
const expressToggle = document.getElementById("express-toggle");
const ratePerPage = document.getElementById("rate-per-page");
const uploadButton = document.getElementById("upload-button");
const uploadStatus = document.getElementById("upload-status");
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
const RATES = { reflow: 0.7, fixed: 3.0, express: 0.2 };

const STATUS_LABELS = {
  received: "Received",
  preparing: "Reading your pages",
  processing: "In the OCR queue",
  awaiting_ocr: "In the OCR queue",
  assembling: "Assembling your edition",
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
  { id: "fx-1", mode: "reflow", express: false, status: "received", title: "Mughal Gardens survey", pageCount: null, error: null, createdAt: agoIso(40 * 1000) },
  { id: "fx-2", mode: "reflow", express: true, status: "preparing", title: "Kitab al-Aghani, volume 3", pageCount: null, error: null, createdAt: agoIso(3 * 60 * 1000) },
  { id: "fx-3", mode: "reflow", express: false, status: "processing", title: "The Deccan Sultanates", pageCount: 412, error: null, createdAt: agoIso(18 * 60 * 1000) },
  { id: "fx-4", mode: "fixed", express: false, status: "awaiting_ocr", title: null, pageCount: 96, error: null, createdAt: agoIso(52 * 60 * 1000) },
  { id: "fx-5", mode: "fixed", express: true, status: "assembling", title: "Persian Miniatures, plates", pageCount: 58, error: null, createdAt: agoIso(4 * 60 * 60 * 1000) },
  { id: "fx-6", mode: "reflow", express: false, status: "ready", title: "A Grammar of the Persian Language", pageCount: 214, error: null, createdAt: agoIso(30 * 60 * 60 * 1000) },
  { id: "fx-7", mode: "reflow", express: false, status: "failed", title: "Field notebook, 1911", pageCount: null, error: "we could not read this file", createdAt: agoIso(3 * 24 * 60 * 60 * 1000) },
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
  if (job.express) {
    titleRow.appendChild(el("span", "job__express", "Express"));
  }
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
  row.appendChild(main);

  const chip = el("span", `status ${statusClass(job.status)}`.trim());
  chip.appendChild(el("span", "status__dot"));
  chip.appendChild(document.createTextNode(STATUS_LABELS[job.status] || job.status));
  row.appendChild(chip);

  return row;
}

function renderJobs(jobs) {
  jobsList.replaceChildren();
  if (jobs.length === 0) {
    jobsCount.hidden = true;
    jobsList.appendChild(renderEmptyState());
  } else {
    jobsCount.hidden = false;
    jobsCount.textContent = jobs.length === 1 ? "1 edition" : `${jobs.length} editions`;
    for (const job of jobs) {
      jobsList.appendChild(renderJob(job));
    }
  }
  schedulePoll(jobs);
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
let selectedFile = null;

function formatSize(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function selectedMode() {
  const checked = document.querySelector('input[name="job-mode"]:checked');
  return checked ? checked.value : "reflow";
}

function updateRateNote() {
  const rate = RATES[selectedMode()] + (expressToggle.checked ? RATES.express : 0);
  ratePerPage.textContent = rate.toFixed(1);
}

function showUploadStatus(message, kind) {
  uploadStatus.textContent = message;
  uploadStatus.classList.toggle("upload-status--error", kind === "error");
  uploadStatus.hidden = false;
}

function hideUploadStatus() {
  uploadStatus.hidden = true;
}

function setFile(file) {
  if (!file) return;
  const looksPdf =
    file.type === "application/pdf" || /\.pdf$/i.test(file.name || "");
  if (!looksPdf) {
    showUploadStatus("That does not look like a PDF. We read scanned PDFs only, for now.", "error");
    return;
  }
  hideUploadStatus();
  selectedFile = file;
  dropZone.classList.add("has-file");
  dropZoneLine.hidden = true;
  dropZoneFile.hidden = false;
  dropZoneFile.textContent = `${file.name}  ·  ${formatSize(file.size)}`;
}

function clearFile() {
  selectedFile = null;
  fileInput.value = "";
  dropZone.classList.remove("has-file");
  dropZoneLine.hidden = false;
  dropZoneFile.hidden = true;
  dropZoneFile.textContent = "";
}

async function submitUpload() {
  hideUploadStatus();
  if (!selectedFile) {
    showUploadStatus("Choose a PDF first, then we can begin.", "error");
    return;
  }

  uploadButton.disabled = true;
  const restLabel = uploadButton.textContent;
  uploadButton.textContent = "Uploading your scan...";

  try {
    const params = new URLSearchParams({
      mode: selectedMode(),
      express: expressToggle.checked ? "1" : "0",
    });
    const title = jobTitle.value.trim();
    if (title) params.set("title", title);

    const job = await api(`/api/jobs?${params.toString()}`, {
      method: "POST",
      headers: { "content-type": "application/pdf" },
      body: selectedFile,
    });

    try {
      await api(`/api/jobs/${job.id}/start`, { method: "POST" });
      showUploadStatus("Your scan is in. We are reading the pages now.");
      clearFile();
      jobTitle.value = "";
    } catch (err) {
      if (err.status === 402) {
        // e.g. "Not enough credits for this document. Your balance is 3.4 credits."
        const balance =
          currentBalance == null ? "" : ` Your balance is ${currentBalance.toFixed(1)} credits.`;
        showUploadStatus(`${sentence(err.message)}.${balance}`, "error");
      } else {
        showUploadStatus(`${sentence(err.message)}.`, "error");
      }
    }

    await refreshJobs();
    await refreshMe();
  } catch (err) {
    // 400 and 413 arrive here with the server's envelope message.
    showUploadStatus(`${sentence(err.message)}.`, "error");
  } finally {
    uploadButton.disabled = false;
    uploadButton.textContent = restLabel;
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
  fileInput.addEventListener("change", () => setFile(fileInput.files[0]));

  dropZone.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-drag");
  });
  dropZone.addEventListener("dragleave", () => dropZone.classList.remove("is-drag"));
  dropZone.addEventListener("drop", (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-drag");
    setFile(event.dataTransfer?.files?.[0]);
  });

  for (const radio of document.querySelectorAll('input[name="job-mode"]')) {
    radio.addEventListener("change", updateRateNote);
  }
  expressToggle.addEventListener("change", updateRateNote);
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
