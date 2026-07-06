# Thothica OCR SaaS, plan UI-1: login and app shell

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The real Thothica OCR front end: a genuinely beautiful login page (Google sign in + email magic link, no passwords) and the authenticated app shell (credit balance, jobs list, upload panel wired to the live API), responsive from 360px to ultra wide. Deployable independently of the container work.

**Architecture:** Static app in `cloud/frontend/` served by the existing Worker (Workers Assets, SPA fallback). No build step, no framework: hand written ES modules + Firebase Web SDK v10 loaded as ES modules from the Firebase CDN (gstatic), which keeps the repo dependency free. Auth state drives a two view app: signed out -> login view; signed in -> app view. Every API call sends the Firebase ID token.

**Brand (hard requirements, from the thothica-brand skill and the shipped console):** Cormorant Garamond + Teachers via Google Fonts; palette variables exactly as in `src/pdf2fxl/web/static/app.css` (:root block); the real ibis logo asset copied from `src/pdf2fxl/web/static/thothica-logo.png`; gold as seasoning only; sentence case; ZERO em or en dashes in any visible copy (lint with `grep -rn $'—\|–' cloud/frontend/`); no vendor names (mistral, pdf2fxl) anywhere.

**Firebase facts (configured 2026-07-06, do not re-derive):** project `thothica-ocr`; web config: apiKey `AIzaSyA5NPFQgUIqZzyuZNPvvUNFHdvLtCZ78co`, authDomain `thothica-ocr.firebaseapp.com`, appId `1:642710297096:web:f66838eb3fddedc5418fbd` (public values, safe in the client). Providers: Google, and email link (passwordless: `passwordRequired=false`). Authorized domains include localhost and the workers.dev host. Magic link flow: `sendSignInLinkToEmail` with `actionCodeSettings = { url: location.origin + "/", handleCodeInApp: true }`, store the email in localStorage, and on load complete sign in via `isSignInWithEmailLink` + `signInWithEmailLink`.

**Verification loop (house rule):** every visual task ends with `wrangler dev` + the preview tools (screenshots at 375px and 1280px) actually looked at, not assumed. Functional flows are exercised in the browser preview. The engine and worker test suites must stay green throughout (`npx vitest run` in cloud/worker: 71 passed).

**Execution notes:** implementer subagents MUST invoke the `anthropic-skills:thothica-brand` skill and the `frontend-design:frontend-design` skill before writing UI code, and follow them. Do not touch `cloud/worker/src` except where a task says so. Commits per task with the Co-Authored-By trailer. Do not push.

---

### Task 1: App scaffold and auth core

**Files:**
- Create: `cloud/frontend/app.js` (auth state machine, API client)
- Create: `cloud/frontend/firebase.js` (Firebase init + auth helpers)
- Modify: `cloud/frontend/index.html` (becomes the real app shell: login view + app view containers)
- Copy: `src/pdf2fxl/web/static/thothica-logo.png` -> `cloud/frontend/thothica-logo.png`

Behavior contract:
- `firebase.js` exports `initAuth(onUser)` (subscribes to auth state), `signInWithGoogle()` (popup), `sendMagicLink(email)` (with actionCodeSettings above, saves email to localStorage key `pendingEmail`), `completeMagicLink()` (called on every load; finishes email link sign in when the URL is a sign in link), `signOutUser()`, `getToken()` (current user ID token).
- `app.js` exports `api(path, opts)` which attaches `Authorization: Bearer <token>` and parses the JSON error envelope; on 401 it flips to the login view.
- `index.html` has two top level sections: `#login-view` and `#app-view` (hidden until signed in), plus a tiny inline boot script importing app.js as a module. No inline styles; styling arrives in Tasks 2 and 3.
- The Firebase SDK is imported from `https://www.gstatic.com/firebasejs/10.14.1/firebase-app.js` and `firebase-auth.js` as ES modules.

Verify: `cd cloud/worker && npx wrangler dev` then in the browser preview: page loads with both views present (login visible, app hidden), no console errors from the module imports, `completeMagicLink` runs without throwing on a normal load. Commit `feat(ui): app scaffold with Firebase auth core`.

### Task 2: The login page (the signature piece)

**Files:**
- Modify: `cloud/frontend/index.html` (login view markup)
- Create: `cloud/frontend/ui.css` (replaces shell.css; keep the :root palette block verbatim)
- Delete: `cloud/frontend/shell.css`

This is the front door and must be genuinely beautiful, warm editorial, unmistakably Thothica. Requirements:
- Ibis logo + wordmark, an editorial headline in Cormorant Garamond (sentence case, e.g. "Clean digital editions from any scan."), one short supporting line, then the two sign in affordances: a Google button and an email field + "Send me a sign in link" button. After sending: a calm confirmation state ("Check your inbox. The link signs you in on this device.").
- A quiet signature visual: reuse the type size histogram motif from the console hero (inline SVG, palette colors) so the page explains the product without copy.
- Responsive: single column under 720px, generous asymmetric two column above; padding audited at 375px and 1280px; tap targets at least 44px.
- Zero dashes, no vendor names, `<title>Thothica OCR</title>`, favicon optional.

Verify with preview screenshots at 375px and 1280px, inspect padding and font loading (preview_inspect on the headline: font-family must resolve to Cormorant Garamond), dash + vendor lint. Commit `feat(ui): Thothica OCR login page`.

### Task 3: App shell, balance, jobs list, upload

**Files:**
- Modify: `cloud/frontend/index.html` (app view markup)
- Modify: `cloud/frontend/ui.css`
- Modify: `cloud/frontend/app.js`

Signed in experience:
- Header: logo, product name, credit balance chip (from `GET /api/me`, shown as credits with one decimal), user email, sign out.
- Upload panel: drop zone + file picker for PDFs, mode toggle (Reflowable edition / Fixed layout edition) with per page prices from a `RATES` constant (0.7 and 3.0, express +0.2 shown as "Express" toggle), title field, submit calls `POST /api/jobs?mode=...&express=...&title=...` with the raw PDF body then `POST /api/jobs/:id/start`, then refreshes the list. Insufficient credits (402) shows a warm, plain message with the shortfall, not an alert box.
- Jobs list: `GET /api/jobs` rendered as cards or rows: title or "Untitled scan", mode, page count when known, status as a friendly label (received -> "Received", processing -> "Reading your pages", failed -> the errorPublic text, ready -> "Ready"), created date. Poll every 10s while any job is not terminal.
- Admin link visible only when `isAdmin` (routes to Task 4's panel; may be a stub hash route until Task 4 lands).
- Empty state: an inviting first run card, not a blank list.

Verify in the preview: sign in with a real magic link is not automatable headlessly, so for the visual pass use a temporary `?dev-preview=1` query flag that renders the app view with fixture data WITHOUT auth (the flag must not bypass real API calls; it only shows fixtures) and REMOVE the flag before commit, or keep it behind `location.hostname === "localhost"` and document it. Screenshots at 375px and 1280px. Suite still green. Commit `feat(ui): authenticated app shell with upload and jobs`.

### Task 4: Admin panel

**Files:**
- Modify: `cloud/frontend/index.html`, `cloud/frontend/ui.css`, `cloud/frontend/app.js`

Hash route `#admin`, visible only for admins (server enforces anyway): users table (email, name, balance, admin badge) from `GET /api/admin/users`; allocate form (email, credits, note) posting to `POST /api/admin/credits` with optimistic refresh; per user statement drawer from `GET /api/admin/users/:id/ledger` (kind, signed credits, job link, note, who, when). Same brand treatment; tables must degrade to stacked cards under 720px.

Verify: preview screenshots (fixtures acceptable for visuals), lint, suite green. Commit `feat(ui): admin panel for credits and users`.

### Task 5: Deploy and real flow verification

- `npx wrangler deploy` (worker + assets; requires no container so it deploys on the free plan; if the containers block in wrangler.jsonc forces a container build on every deploy, deploy with the plan 2a container commits reverted... it does not: assets and worker deploy fine as long as the container image push succeeds or the containers block is temporarily commented. If the paid plan is active by now, deploy normally).
- Real verification (needs Adnan or an inbox the operator controls): sign in with Google, sign in with a magic link, see zero balance, attempt an upload (402 without credits), admin allocates credits to the account, upload again, watch the job reach processing (or awaiting the engine if the container is not yet deployed).
- Screenshot the deployed login at mobile and desktop. Update memory with what shipped.

Commit any final fixes as `fix(ui): ...`.

## Out of scope

Job detail view with TOC preview, downloads (needs plan 2b artifacts), bulk multi file UX (plan for it will follow 2b), email notifications, landing page (permanently out per Adnan).
