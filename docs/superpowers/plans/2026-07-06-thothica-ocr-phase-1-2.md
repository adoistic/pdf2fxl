# Thothica OCR SaaS, plan 1 of 7: platform skeleton and credits ledger

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A deployed Cloudflare Worker at workers.dev with D1, Firebase token verification, an append-only credit ledger with race-safe hold/capture/release, and admin credit allocation. Phases 1 and 2 of the spec `docs/superpowers/specs/2026-07-06-thothica-ocr-saas-design.md`.

**Architecture:** Hono Worker (TypeScript) fronting D1. Firebase ID tokens verified against Google JWKS with `jose` (no server SDK). Credits stored as integer milli-credits (1 credit = 1000 mcr) to avoid float money bugs. Ledger is append only; every mutation is a single atomic SQL statement so concurrent requests cannot double-spend or double-settle. Static frontend shell served via Workers Assets.

**Tech Stack:** Hono ^4, jose ^5, wrangler ^4, D1, Workers Assets, vitest ^3 + @cloudflare/vitest-pool-workers (tests run inside workerd with a real local D1).

**Plan roadmap (this is plan 1):** later plans, one per spec phase, are written after this one deploys: (2) express reflow end to end, (3) batch pipeline + cron + email, (4) fixed layout with ONNX LaMa, (5) bulk and zip, (6) admin panel UI + white label audit, (7) retention, polish, ocrwithai.com cutover.

**Execution notes:**
- Working directory for all tasks: `cloud/worker/` inside this repo unless stated.
- Before running any `wrangler` command in Task 10, invoke the `wrangler` skill (repo rule: skills first).
- The Python engine and existing web console are untouched by this plan.
- Every commit message ends with the Co-Authored-By trailer per repo convention.

---

### Task 1: Worker project scaffold with health route

**Files:**
- Create: `cloud/worker/package.json`
- Create: `cloud/worker/tsconfig.json`
- Create: `cloud/worker/wrangler.jsonc`
- Create: `cloud/worker/vitest.config.ts`
- Create: `cloud/worker/test/env.d.ts`
- Create: `cloud/worker/test/apply-migrations.ts`
- Create: `cloud/worker/migrations/.gitkeep` (the directory must exist for `readD1Migrations`; Task 2 adds the first real migration and removes this file)
- Create: `cloud/worker/src/types.ts`
- Create: `cloud/worker/src/index.ts`
- Test: `cloud/worker/test/health.test.ts`

- [ ] **Step 1: Create the project files**

`cloud/worker/package.json`:

```json
{
  "name": "thothica-ocr-worker",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest",
    "deploy": "wrangler deploy",
    "dev": "wrangler dev"
  },
  "dependencies": {
    "hono": "^4.6.0",
    "jose": "^5.9.0"
  },
  "devDependencies": {
    "@cloudflare/vitest-pool-workers": "^0.8.0",
    "@cloudflare/workers-types": "^4.20250601.0",
    "typescript": "^5.6.0",
    "vitest": "^3.0.0",
    "wrangler": "^4.0.0"
  }
}
```

`cloud/worker/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "es2022",
    "module": "es2022",
    "moduleResolution": "bundler",
    "strict": true,
    "noEmit": true,
    "skipLibCheck": true,
    "lib": ["es2022"],
    "types": ["@cloudflare/workers-types", "@cloudflare/vitest-pool-workers"]
  },
  "include": ["src", "test"]
}
```

`cloud/worker/wrangler.jsonc`:

```jsonc
{
  "name": "thothica-ocr",
  "main": "src/index.ts",
  "compatibility_date": "2026-06-01",
  "assets": {
    "directory": "../frontend",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "thothica-ocr",
      "database_id": "FILLED-IN-BY-TASK-10-STEP-2",
      "migrations_dir": "migrations"
    }
  ],
  "vars": {
    "FIREBASE_PROJECT_ID": "",
    "ADMIN_EMAIL": "adnan@thothica.com"
  },
  "observability": { "enabled": true }
}
```

(The `database_id` value is replaced by a real id in Task 10 Step 2; tests never read it because vitest-pool-workers provisions a local D1.)

`cloud/worker/vitest.config.ts`:

```ts
import path from "node:path";
import {
  defineWorkersConfig,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, "migrations"));
  return {
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
      poolOptions: {
        workers: {
          wrangler: { configPath: "./wrangler.jsonc" },
          miniflare: {
            bindings: {
              TEST_MIGRATIONS: migrations,
              FIREBASE_PROJECT_ID: "test-project",
              ADMIN_EMAIL: "adnan@thothica.com",
            },
          },
        },
      },
    },
  };
});
```

`cloud/worker/test/env.d.ts`:

```ts
import type { Env } from "../src/types";

declare module "cloudflare:test" {
  interface ProvidedEnv extends Env {
    TEST_MIGRATIONS: D1Migration[];
  }
}
```

`cloud/worker/test/apply-migrations.ts`:

```ts
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
```

`cloud/worker/migrations/.gitkeep`: empty file.

`cloud/worker/src/types.ts`:

```ts
export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  FIREBASE_PROJECT_ID: string;
  ADMIN_EMAIL: string;
}

export interface AppUser {
  id: number;
  uid: string | null;
  email: string;
  name: string | null;
  isAdmin: boolean;
}
```

- [ ] **Step 2: Write the failing health test**

`cloud/worker/test/health.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import app from "../src/index";

describe("health", () => {
  it("responds ok without auth", async () => {
    const res = await app.request("/api/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("exposes public config without vendor names", async () => {
    const res = await app.request("/api/config", {}, env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { productName: string; firebaseProjectId: string | null };
    expect(body.productName).toBe("Thothica OCR");
    expect(body.firebaseProjectId).toBe("test-project");
    expect(JSON.stringify(body)).not.toMatch(/mistral|pdf2fxl/i);
  });
});
```

- [ ] **Step 3: Install and run the test to verify it fails**

Run: `cd cloud/worker && npm install && npx vitest run test/health.test.ts`
Expected: FAIL (cannot resolve `../src/index`).

- [ ] **Step 4: Implement the app entry**

`cloud/worker/src/index.ts`:

```ts
import { Hono } from "hono";
import type { AppUser, Env } from "./types";

const app = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", (c) =>
  c.json({
    productName: "Thothica OCR",
    firebaseProjectId: c.env.FIREBASE_PROJECT_ID || null,
  })
);

export default app;
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd cloud/worker && npx vitest run test/health.test.ts`
Expected: 2 passed.

- [ ] **Step 6: Commit**

```bash
git add cloud/worker
git commit -m "feat(saas): worker scaffold with health and config routes"
```

---

### Task 2: D1 schema migration

**Files:**
- Create: `cloud/worker/migrations/0001_init.sql`
- Delete: `cloud/worker/migrations/.gitkeep`
- Test: `cloud/worker/test/schema.test.ts`

- [ ] **Step 1: Write the failing schema test**

`cloud/worker/test/schema.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";

describe("schema", () => {
  it("has users, credit_ledger and config tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name"
    ).all<{ name: string }>();
    const names = results.map((r) => r.name);
    expect(names).toContain("users");
    expect(names).toContain("credit_ledger");
    expect(names).toContain("config");
  });

  it("seeds the pricing config in milli-credits", async () => {
    const { results } = await env.DB.prepare("SELECT key, value FROM config").all<{
      key: string;
      value: string;
    }>();
    const cfg = Object.fromEntries(results.map((r) => [r.key, r.value]));
    expect(cfg.rate_reflow_mcr).toBe("700");
    expect(cfg.rate_fixed_mcr).toBe("3000");
    expect(cfg.express_surcharge_mcr).toBe("200");
    expect(cfg.retention_hours).toBe("72");
  });

  it("rejects a second settlement of the same hold at the schema level", async () => {
    await env.DB.prepare("INSERT INTO users (email) VALUES ('schema@test.dev')").run();
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'schema@test.dev'").first<{ id: number }>();
    const hold = await env.DB.prepare(
      "INSERT INTO credit_ledger (user_id, kind, amount_mcr) VALUES (?1, 'hold', -700) RETURNING id"
    ).bind(user!.id).first<{ id: number }>();
    await env.DB.prepare(
      "INSERT INTO credit_ledger (user_id, kind, amount_mcr, ref_id) VALUES (?1, 'capture', 0, ?2)"
    ).bind(user!.id, hold!.id).run();
    await expect(
      env.DB.prepare(
        "INSERT INTO credit_ledger (user_id, kind, amount_mcr, ref_id) VALUES (?1, 'release', 700, ?2)"
      ).bind(user!.id, hold!.id).run()
    ).rejects.toThrow(/UNIQUE/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cloud/worker && npx vitest run test/schema.test.ts`
Expected: FAIL (no such table: users).

- [ ] **Step 3: Write the migration**

`cloud/worker/migrations/0001_init.sql` (and delete `migrations/.gitkeep`):

```sql
-- Users. uid is the Firebase uid, null until first sign-in (admin can
-- allocate credits to an email before the person ever logs in).
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  uid TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  is_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Append-only credit ledger. Balance = SUM(amount_mcr) per user.
-- Amounts are integer milli-credits (1 credit = 1000 mcr).
-- kinds: allocation (admin grant/revoke), hold (negative reservation),
-- capture (0-amount marker settling a hold as charged),
-- release (positive refund settling a hold as cancelled).
CREATE TABLE credit_ledger (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK (kind IN ('allocation', 'hold', 'capture', 'release')),
  amount_mcr INTEGER NOT NULL,
  job_id TEXT,
  ref_id INTEGER REFERENCES credit_ledger(id),
  note TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- A hold can be settled exactly once (either captured or released), enforced
-- by the database, not application logic. This is the race-condition guard.
CREATE UNIQUE INDEX ux_ledger_settlement
  ON credit_ledger(ref_id)
  WHERE kind IN ('capture', 'release');

CREATE INDEX ix_ledger_user ON credit_ledger(user_id);

CREATE TABLE config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('rate_reflow_mcr', '700'),
  ('rate_fixed_mcr', '3000'),
  ('express_surcharge_mcr', '200'),
  ('retention_hours', '72');
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd cloud/worker && npx vitest run test/schema.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/migrations cloud/worker/test/schema.test.ts
git commit -m "feat(saas): D1 schema for users, append-only credit ledger, config"
```

---

### Task 3: Ledger module, balance and allocation

**Files:**
- Create: `cloud/worker/src/ledger.ts`
- Create: `cloud/worker/test/helpers.ts`
- Test: `cloud/worker/test/ledger.test.ts`

- [ ] **Step 1: Write the test helper and the failing tests**

`cloud/worker/test/helpers.ts`:

```ts
import { env } from "cloudflare:test";

let seq = 0;

export async function createUser(email?: string): Promise<number> {
  const addr = email ?? `user${++seq}-${crypto.randomUUID().slice(0, 8)}@test.dev`;
  const row = await env.DB.prepare("INSERT INTO users (email) VALUES (?1) RETURNING id")
    .bind(addr)
    .first<{ id: number }>();
  return row!.id;
}
```

`cloud/worker/test/ledger.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, getBalanceMcr } from "../src/ledger";
import { createUser } from "./helpers";

describe("ledger: balance and allocation", () => {
  it("new user has zero balance (no trial credits)", async () => {
    const userId = await createUser();
    expect(await getBalanceMcr(env.DB, userId)).toBe(0);
  });

  it("allocation adds to balance and records who and why", async () => {
    const userId = await createUser();
    await allocate(env.DB, {
      userId,
      amountMcr: 100_000,
      note: "client commitment",
      createdBy: "adnan@thothica.com",
    });
    expect(await getBalanceMcr(env.DB, userId)).toBe(100_000);
    const row = await env.DB.prepare(
      "SELECT kind, amount_mcr, note, created_by FROM credit_ledger WHERE user_id = ?1"
    ).bind(userId).first<{ kind: string; amount_mcr: number; note: string; created_by: string }>();
    expect(row).toEqual({
      kind: "allocation",
      amount_mcr: 100_000,
      note: "client commitment",
      created_by: "adnan@thothica.com",
    });
  });

  it("negative allocation (revoke) reduces balance", async () => {
    const userId = await createUser();
    await allocate(env.DB, { userId, amountMcr: 50_000, note: null, createdBy: "adnan@thothica.com" });
    await allocate(env.DB, { userId, amountMcr: -20_000, note: "correction", createdBy: "adnan@thothica.com" });
    expect(await getBalanceMcr(env.DB, userId)).toBe(30_000);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cloud/worker && npx vitest run test/ledger.test.ts`
Expected: FAIL (cannot resolve `../src/ledger`).

- [ ] **Step 3: Implement balance and allocation**

`cloud/worker/src/ledger.ts`:

```ts
// Append-only credit ledger. All amounts are integer milli-credits
// (1 credit = 1000 mcr). Balance is always SUM(amount_mcr) for the user;
// there is no stored balance column to drift out of sync.

export const MCR_PER_CREDIT = 1000;

export async function getBalanceMcr(db: D1Database, userId: number): Promise<number> {
  const row = await db
    .prepare("SELECT COALESCE(SUM(amount_mcr), 0) AS balance FROM credit_ledger WHERE user_id = ?1")
    .bind(userId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

export async function allocate(
  db: D1Database,
  opts: { userId: number; amountMcr: number; note: string | null; createdBy: string }
): Promise<number> {
  if (!Number.isInteger(opts.amountMcr) || opts.amountMcr === 0) {
    throw new Error("allocation must be a non-zero integer amount");
  }
  const row = await db
    .prepare(
      "INSERT INTO credit_ledger (user_id, kind, amount_mcr, note, created_by) VALUES (?1, 'allocation', ?2, ?3, ?4) RETURNING id"
    )
    .bind(opts.userId, opts.amountMcr, opts.note, opts.createdBy)
    .first<{ id: number }>();
  return row!.id;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cloud/worker && npx vitest run test/ledger.test.ts`
Expected: 3 passed.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/src/ledger.ts cloud/worker/test/helpers.ts cloud/worker/test/ledger.test.ts
git commit -m "feat(saas): ledger balance and admin allocation"
```

---

### Task 4: Ledger holds with atomic balance check

**Files:**
- Modify: `cloud/worker/src/ledger.ts` (append functions)
- Test: `cloud/worker/test/ledger-hold.test.ts`

- [ ] **Step 1: Write the failing tests**

`cloud/worker/test/ledger-hold.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, getBalanceMcr, placeHold } from "../src/ledger";
import { createUser } from "./helpers";

async function fund(userId: number, amountMcr: number) {
  await allocate(env.DB, { userId, amountMcr, note: null, createdBy: "adnan@thothica.com" });
}

describe("ledger: holds", () => {
  it("places a hold when balance is sufficient and reduces available balance", async () => {
    const userId = await createUser();
    await fund(userId, 10_000); // 10 credits
    const res = await placeHold(env.DB, { userId, jobId: "job-1", amountMcr: 7_000 });
    expect(res.ok).toBe(true);
    expect(await getBalanceMcr(env.DB, userId)).toBe(3_000);
  });

  it("refuses a hold beyond the available balance, atomically", async () => {
    const userId = await createUser();
    await fund(userId, 5_000);
    const res = await placeHold(env.DB, { userId, jobId: "job-2", amountMcr: 7_000 });
    expect(res).toEqual({ ok: false, reason: "insufficient_credits" });
    expect(await getBalanceMcr(env.DB, userId)).toBe(5_000);
  });

  it("counts existing holds against the balance for new holds", async () => {
    const userId = await createUser();
    await fund(userId, 10_000);
    const first = await placeHold(env.DB, { userId, jobId: "job-3a", amountMcr: 7_000 });
    expect(first.ok).toBe(true);
    const second = await placeHold(env.DB, { userId, jobId: "job-3b", amountMcr: 7_000 });
    expect(second).toEqual({ ok: false, reason: "insufficient_credits" });
  });

  it("rejects non-positive hold amounts", async () => {
    const userId = await createUser();
    await fund(userId, 10_000);
    await expect(placeHold(env.DB, { userId, jobId: "job-4", amountMcr: 0 })).rejects.toThrow();
    await expect(placeHold(env.DB, { userId, jobId: "job-4", amountMcr: -5 })).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cloud/worker && npx vitest run test/ledger-hold.test.ts`
Expected: FAIL (`placeHold` is not exported).

- [ ] **Step 3: Implement placeHold**

Append to `cloud/worker/src/ledger.ts`:

```ts
export type HoldResult =
  | { ok: true; holdId: number }
  | { ok: false; reason: "insufficient_credits" };

// Single-statement check-and-insert: the SELECT computes the balance and the
// INSERT only happens when it covers the hold. D1 executes the statement
// atomically, so two concurrent holds cannot both pass a balance that only
// covers one of them.
export async function placeHold(
  db: D1Database,
  opts: { userId: number; jobId: string; amountMcr: number }
): Promise<HoldResult> {
  if (!Number.isInteger(opts.amountMcr) || opts.amountMcr <= 0) {
    throw new Error("hold amount must be a positive integer");
  }
  const row = await db
    .prepare(
      `INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id)
       SELECT ?1, 'hold', ?2, ?3
       WHERE (SELECT COALESCE(SUM(amount_mcr), 0) FROM credit_ledger WHERE user_id = ?1) >= ?4
       RETURNING id`
    )
    .bind(opts.userId, -opts.amountMcr, opts.jobId, opts.amountMcr)
    .first<{ id: number }>();
  return row ? { ok: true, holdId: row.id } : { ok: false, reason: "insufficient_credits" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cloud/worker && npx vitest run test/ledger-hold.test.ts`
Expected: 4 passed.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/src/ledger.ts cloud/worker/test/ledger-hold.test.ts
git commit -m "feat(saas): atomic credit holds with balance check"
```

---

### Task 5: Ledger capture and release, race-safe settlement

**Files:**
- Modify: `cloud/worker/src/ledger.ts` (append functions)
- Test: `cloud/worker/test/ledger-settle.test.ts`

- [ ] **Step 1: Write the failing tests**

`cloud/worker/test/ledger-settle.test.ts`:

```ts
import { env } from "cloudflare:test";
import { describe, it, expect } from "vitest";
import { allocate, captureHold, getBalanceMcr, placeHold, releaseHold } from "../src/ledger";
import { createUser } from "./helpers";

async function fundedHold(amountMcr: number, fundMcr = 100_000) {
  const userId = await createUser();
  await allocate(env.DB, { userId, amountMcr: fundMcr, note: null, createdBy: "adnan@thothica.com" });
  const hold = await placeHold(env.DB, { userId, jobId: "job-x", amountMcr });
  if (!hold.ok) throw new Error("test setup: hold failed");
  return { userId, holdId: hold.holdId };
}

describe("ledger: capture and release", () => {
  it("capture keeps the charge; balance stays reduced", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await captureHold(env.DB, holdId)).toBe(true);
    expect(await getBalanceMcr(env.DB, userId)).toBe(93_000);
  });

  it("release refunds the hold in full", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await releaseHold(env.DB, holdId)).toBe(true);
    expect(await getBalanceMcr(env.DB, userId)).toBe(100_000);
  });

  it("a hold settles exactly once: second capture is a no-op", async () => {
    const { holdId } = await fundedHold(7_000);
    expect(await captureHold(env.DB, holdId)).toBe(true);
    expect(await captureHold(env.DB, holdId)).toBe(false);
  });

  it("cannot release after capture (no refund of a delivered job)", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await captureHold(env.DB, holdId)).toBe(true);
    expect(await releaseHold(env.DB, holdId)).toBe(false);
    expect(await getBalanceMcr(env.DB, userId)).toBe(93_000);
  });

  it("cannot capture after release (no charging a refunded job)", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    expect(await releaseHold(env.DB, holdId)).toBe(true);
    expect(await captureHold(env.DB, holdId)).toBe(false);
    expect(await getBalanceMcr(env.DB, userId)).toBe(100_000);
  });

  it("concurrent capture and release: exactly one wins", async () => {
    const { userId, holdId } = await fundedHold(7_000);
    const [c, r] = await Promise.all([
      captureHold(env.DB, holdId),
      releaseHold(env.DB, holdId),
    ]);
    expect([c, r].filter(Boolean)).toHaveLength(1);
    const balance = await getBalanceMcr(env.DB, userId);
    expect([93_000, 100_000]).toContain(balance);
  });

  it("settling a nonexistent or non-hold row does nothing", async () => {
    const { holdId } = await fundedHold(7_000);
    expect(await captureHold(env.DB, 999_999)).toBe(false);
    expect(await captureHold(env.DB, holdId + 0)).toBe(true); // sanity: real hold still works
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cloud/worker && npx vitest run test/ledger-settle.test.ts`
Expected: FAIL (`captureHold` is not exported).

- [ ] **Step 3: Implement captureHold and releaseHold**

Append to `cloud/worker/src/ledger.ts`:

```ts
// Settlement rows reference their hold via ref_id. The partial unique index
// ux_ledger_settlement lets exactly one settlement row exist per hold, so a
// concurrent capture and release cannot both succeed; the loser hits the
// UNIQUE constraint and reports false.

function isUniqueViolation(err: unknown): boolean {
  return String(err).includes("UNIQUE");
}

// Capture: the job delivered. The hold's negative amount stands as the final
// charge; the capture row is a zero-amount marker that locks the hold.
export async function captureHold(db: D1Database, holdId: number): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id, ref_id)
         SELECT user_id, 'capture', 0, job_id, id
         FROM credit_ledger WHERE id = ?1 AND kind = 'hold'`
      )
      .bind(holdId)
      .run();
    return res.meta.changes === 1;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}

// Release: the job failed or was cancelled. Insert the exact opposite of the
// hold amount, refunding it in full.
export async function releaseHold(db: D1Database, holdId: number): Promise<boolean> {
  try {
    const res = await db
      .prepare(
        `INSERT INTO credit_ledger (user_id, kind, amount_mcr, job_id, ref_id)
         SELECT user_id, 'release', -amount_mcr, job_id, id
         FROM credit_ledger WHERE id = ?1 AND kind = 'hold'`
      )
      .bind(holdId)
      .run();
    return res.meta.changes === 1;
  } catch (err) {
    if (isUniqueViolation(err)) return false;
    throw err;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cloud/worker && npx vitest run test/ledger-settle.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Run the full worker suite**

Run: `cd cloud/worker && npm test`
Expected: all tests pass (health, schema, ledger, ledger-hold, ledger-settle).

- [ ] **Step 6: Commit**

```bash
git add cloud/worker/src/ledger.ts cloud/worker/test/ledger-settle.test.ts
git commit -m "feat(saas): race-safe hold settlement (capture and release)"
```

---

### Task 6: Firebase auth middleware

**Files:**
- Create: `cloud/worker/src/auth.ts`
- Create: `cloud/worker/test/firebase-mock.ts`
- Test: `cloud/worker/test/auth.test.ts`

- [ ] **Step 1: Write the mock and the failing tests**

`cloud/worker/test/firebase-mock.ts`:

```ts
// Generates a real RSA keypair, serves its public JWK through fetchMock at
// Google's JWKS URL, and signs Firebase-shaped ID tokens with the private key.
// Auth tests therefore exercise genuine RS256 verification, not a stub.
import { exportJWK, generateKeyPair, SignJWT } from "jose";

export interface FirebaseMock {
  jwks: { keys: Record<string, unknown>[] };
  tokenFor(
    claims: { sub: string; email: string; name?: string },
    overrides?: { issuer?: string; audience?: string; expiresAt?: number }
  ): Promise<string>;
  foreignTokenFor(claims: { sub: string; email: string }): Promise<string>;
}

export async function makeFirebaseMock(projectId: string): Promise<FirebaseMock> {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  const foreign = await generateKeyPair("RS256", { extractable: true });
  const jwk = { ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" };

  async function sign(
    key: CryptoKey,
    kid: string,
    claims: { sub: string; email: string; name?: string },
    overrides: { issuer?: string; audience?: string; expiresAt?: number } = {}
  ) {
    return new SignJWT({ email: claims.email, ...(claims.name ? { name: claims.name } : {}) })
      .setProtectedHeader({ alg: "RS256", kid })
      .setSubject(claims.sub)
      .setIssuer(overrides.issuer ?? `https://securetoken.google.com/${projectId}`)
      .setAudience(overrides.audience ?? projectId)
      .setIssuedAt()
      .setExpirationTime(overrides.expiresAt ?? Math.floor(Date.now() / 1000) + 3600)
      .sign(key);
  }

  return {
    jwks: { keys: [jwk] },
    tokenFor: (claims, overrides) => sign(privateKey, "test-key", claims, overrides),
    foreignTokenFor: (claims) => sign(foreign.privateKey, "test-key", claims),
  };
}
```

`cloud/worker/test/auth.test.ts`:

```ts
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import app from "../src/index";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;

beforeAll(async () => {
  fb = await makeFirebaseMock("test-project");
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://www.googleapis.com")
    .intercept({ path: "/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com" })
    .reply(200, JSON.stringify(fb.jwks), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    })
    .persist();
});

async function me(token?: string) {
  return app.request(
    "/api/me",
    { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    env
  );
}

describe("auth", () => {
  it("rejects requests without a token", async () => {
    const res = await me();
    expect(res.status).toBe(401);
  });

  it("rejects tokens signed by the wrong key", async () => {
    const res = await me(await fb.foreignTokenFor({ sub: "u1", email: "evil@test.dev" }));
    expect(res.status).toBe(401);
  });

  it("rejects tokens for a different Firebase project", async () => {
    const res = await me(
      await fb.tokenFor({ sub: "u1", email: "a@test.dev" }, { audience: "other-project" })
    );
    expect(res.status).toBe(401);
  });

  it("rejects expired tokens", async () => {
    const res = await me(
      await fb.tokenFor(
        { sub: "u1", email: "a@test.dev" },
        { expiresAt: Math.floor(Date.now() / 1000) - 60 }
      )
    );
    expect(res.status).toBe(401);
  });

  it("accepts a valid token, creates the user, returns zero balance", async () => {
    const res = await me(await fb.tokenFor({ sub: "uid-alpha", email: "Alpha@Test.dev", name: "Alpha" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      email: string; name: string | null; isAdmin: boolean; balance: number; balanceMcr: number;
    };
    expect(body).toEqual({
      email: "alpha@test.dev",
      name: "Alpha",
      isAdmin: false,
      balance: 0,
      balanceMcr: 0,
    });
  });

  it("links the Firebase uid to a pre-created email row instead of duplicating", async () => {
    await env.DB.prepare("INSERT INTO users (email) VALUES ('pre@test.dev')").run();
    const res = await me(await fb.tokenFor({ sub: "uid-pre", email: "pre@test.dev" }));
    expect(res.status).toBe(200);
    const { results } = await env.DB.prepare(
      "SELECT uid FROM users WHERE email = 'pre@test.dev'"
    ).all<{ uid: string | null }>();
    expect(results).toHaveLength(1);
    expect(results[0].uid).toBe("uid-pre");
  });

  it("grants admin to the configured admin email", async () => {
    const res = await me(await fb.tokenFor({ sub: "uid-adnan", email: "adnan@thothica.com" }));
    const body = (await res.json()) as { isAdmin: boolean };
    expect(body.isAdmin).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cloud/worker && npx vitest run test/auth.test.ts`
Expected: FAIL (404s: no `/api/me` route yet).

- [ ] **Step 3: Implement the middleware**

`cloud/worker/src/auth.ts`:

```ts
import { createRemoteJWKSet, jwtVerify } from "jose";
import type { MiddlewareHandler } from "hono";
import type { AppUser, Env } from "./types";

const JWKS_URL =
  "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export interface FirebaseIdentity {
  uid: string;
  email: string;
  name: string | null;
}

export async function verifyFirebaseToken(
  token: string,
  projectId: string
): Promise<FirebaseIdentity> {
  jwks ??= createRemoteJWKSet(new URL(JWKS_URL));
  const { payload } = await jwtVerify(token, jwks, {
    issuer: `https://securetoken.google.com/${projectId}`,
    audience: projectId,
  });
  if (!payload.sub || typeof payload.email !== "string") {
    throw new Error("token has no identity");
  }
  return {
    uid: payload.sub,
    email: payload.email.toLowerCase(),
    name: typeof payload.name === "string" ? payload.name : null,
  };
}

type AppContext = { Bindings: Env; Variables: { user: AppUser } };

export const authRequired: MiddlewareHandler<AppContext> = async (c, next) => {
  const header = c.req.header("Authorization");
  if (!header?.startsWith("Bearer ")) {
    return c.json({ error: "sign in required" }, 401);
  }
  let identity: FirebaseIdentity;
  try {
    identity = await verifyFirebaseToken(header.slice(7), c.env.FIREBASE_PROJECT_ID);
  } catch {
    return c.json({ error: "sign in required" }, 401);
  }
  const seedAdmin = identity.email === c.env.ADMIN_EMAIL.toLowerCase() ? 1 : 0;
  const row = await c.env.DB.prepare(
    `INSERT INTO users (uid, email, name, is_admin) VALUES (?1, ?2, ?3, ?4)
     ON CONFLICT(email) DO UPDATE SET
       uid = excluded.uid,
       name = COALESCE(excluded.name, users.name),
       is_admin = MAX(users.is_admin, excluded.is_admin)
     RETURNING id, uid, email, name, is_admin`
  )
    .bind(identity.uid, identity.email, identity.name, seedAdmin)
    .first<{ id: number; uid: string; email: string; name: string | null; is_admin: number }>();
  c.set("user", {
    id: row!.id,
    uid: row!.uid,
    email: row!.email,
    name: row!.name,
    isAdmin: row!.is_admin === 1,
  });
  await next();
};

export const adminRequired: MiddlewareHandler<AppContext> = async (c, next) => {
  if (!c.get("user")?.isAdmin) {
    return c.json({ error: "not allowed" }, 403);
  }
  await next();
};
```

Modify `cloud/worker/src/index.ts` to add the `/api/me` route (full file after the change):

```ts
import { Hono } from "hono";
import type { AppUser, Env } from "./types";
import { authRequired } from "./auth";
import { getBalanceMcr, MCR_PER_CREDIT } from "./ledger";

const app = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/config", (c) =>
  c.json({
    productName: "Thothica OCR",
    firebaseProjectId: c.env.FIREBASE_PROJECT_ID || null,
  })
);

app.use("/api/me", authRequired);
app.get("/api/me", async (c) => {
  const user = c.get("user");
  const balanceMcr = await getBalanceMcr(c.env.DB, user.id);
  return c.json({
    email: user.email,
    name: user.name,
    isAdmin: user.isAdmin,
    balanceMcr,
    balance: balanceMcr / MCR_PER_CREDIT,
  });
});

export default app;
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cloud/worker && npx vitest run test/auth.test.ts`
Expected: 7 passed.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/src/auth.ts cloud/worker/src/index.ts cloud/worker/test/firebase-mock.ts cloud/worker/test/auth.test.ts
git commit -m "feat(saas): Firebase token verification and user upsert middleware"
```

---

### Task 7: Admin routes, allocate credits and list users

**Files:**
- Create: `cloud/worker/src/routes/admin.ts`
- Modify: `cloud/worker/src/index.ts`
- Test: `cloud/worker/test/admin.test.ts`

- [ ] **Step 1: Write the failing tests**

`cloud/worker/test/admin.test.ts`:

```ts
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import app from "../src/index";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;
let adminToken: string;
let userToken: string;

beforeAll(async () => {
  fb = await makeFirebaseMock("test-project");
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://www.googleapis.com")
    .intercept({ path: "/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com" })
    .reply(200, JSON.stringify(fb.jwks), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    })
    .persist();
  adminToken = await fb.tokenFor({ sub: "uid-adnan", email: "adnan@thothica.com", name: "Adnan" });
  userToken = await fb.tokenFor({ sub: "uid-plain", email: "plain@test.dev" });
});

function post(path: string, token: string, body: unknown) {
  return app.request(
    path,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    },
    env
  );
}

describe("admin credits", () => {
  it("non-admin cannot allocate", async () => {
    const res = await post("/api/admin/credits", userToken, {
      email: "x@test.dev",
      credits: 10,
    });
    expect(res.status).toBe(403);
  });

  it("admin allocates to a brand new email (user created on the spot)", async () => {
    const res = await post("/api/admin/credits", adminToken, {
      email: "NewClient@test.dev",
      credits: 250,
      note: "pilot batch",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "newclient@test.dev", balanceMcr: 250_000, balance: 250 });
  });

  it("fractional credits allocate exactly in milli-credits", async () => {
    const res = await post("/api/admin/credits", adminToken, {
      email: "frac@test.dev",
      credits: 0.7,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ email: "frac@test.dev", balanceMcr: 700, balance: 0.7 });
  });

  it("rejects garbage requests", async () => {
    for (const bad of [
      { email: "no-at-sign", credits: 10 },
      { email: "a@test.dev", credits: 0 },
      { email: "a@test.dev", credits: Number.NaN },
      { email: "a@test.dev" },
      {},
    ]) {
      const res = await post("/api/admin/credits", adminToken, bad);
      expect(res.status).toBe(400);
    }
  });

  it("lists users with balances", async () => {
    await post("/api/admin/credits", adminToken, { email: "listme@test.dev", credits: 42 });
    const res = await app.request(
      "/api/admin/users",
      { headers: { Authorization: `Bearer ${adminToken}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users: { email: string; balance: number }[] };
    const target = body.users.find((u) => u.email === "listme@test.dev");
    expect(target?.balance).toBe(42);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd cloud/worker && npx vitest run test/admin.test.ts`
Expected: FAIL (404 on /api/admin routes).

- [ ] **Step 3: Implement the admin routes**

`cloud/worker/src/routes/admin.ts`:

```ts
import { Hono } from "hono";
import type { AppUser, Env } from "../types";
import { allocate, getBalanceMcr, MCR_PER_CREDIT } from "../ledger";

export const admin = new Hono<{ Bindings: Env; Variables: { user: AppUser } }>();

admin.post("/credits", async (c) => {
  const body = await c.req
    .json<{ email?: unknown; credits?: unknown; note?: unknown }>()
    .catch(() => null);
  const email = typeof body?.email === "string" ? body.email.toLowerCase().trim() : "";
  const credits = typeof body?.credits === "number" ? body.credits : Number.NaN;
  const note = typeof body?.note === "string" ? body.note : null;
  if (
    !email.includes("@") ||
    !Number.isFinite(credits) ||
    credits === 0 ||
    Math.abs(credits) > 1_000_000
  ) {
    return c.json({ error: "invalid request" }, 400);
  }
  const userRow = await c.env.DB.prepare(
    "INSERT INTO users (email) VALUES (?1) ON CONFLICT(email) DO UPDATE SET email = excluded.email RETURNING id"
  )
    .bind(email)
    .first<{ id: number }>();
  await allocate(c.env.DB, {
    userId: userRow!.id,
    amountMcr: Math.round(credits * MCR_PER_CREDIT),
    note,
    createdBy: c.get("user").email,
  });
  const balanceMcr = await getBalanceMcr(c.env.DB, userRow!.id);
  return c.json({ email, balanceMcr, balance: balanceMcr / MCR_PER_CREDIT });
});

admin.get("/users", async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.is_admin, COALESCE(SUM(l.amount_mcr), 0) AS balance_mcr
     FROM users u
     LEFT JOIN credit_ledger l ON l.user_id = u.id
     GROUP BY u.id
     ORDER BY u.id DESC`
  ).all<{ id: number; email: string; name: string | null; is_admin: number; balance_mcr: number }>();
  return c.json({
    users: results.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      isAdmin: r.is_admin === 1,
      balance: r.balance_mcr / MCR_PER_CREDIT,
    })),
  });
});
```

Modify `cloud/worker/src/index.ts`: add two imports and two lines before `export default app;`:

```ts
import { adminRequired } from "./auth";   // extend the existing import from "./auth"
import { admin } from "./routes/admin";
```

(the auth import line becomes `import { adminRequired, authRequired } from "./auth";`)

```ts
app.use("/api/admin/*", authRequired, adminRequired);
app.route("/api/admin", admin);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cloud/worker && npx vitest run test/admin.test.ts`
Expected: 5 passed.

- [ ] **Step 5: Run the full suite**

Run: `cd cloud/worker && npm test`
Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add cloud/worker/src/routes/admin.ts cloud/worker/src/index.ts cloud/worker/test/admin.test.ts
git commit -m "feat(saas): admin credit allocation and user listing"
```

---

### Task 8: Ledger audit view for the admin (per-user statement)

**Files:**
- Modify: `cloud/worker/src/routes/admin.ts`
- Test: `cloud/worker/test/admin-statement.test.ts`

- [ ] **Step 1: Write the failing test**

`cloud/worker/test/admin-statement.test.ts`:

```ts
import { env, fetchMock } from "cloudflare:test";
import { beforeAll, describe, it, expect } from "vitest";
import app from "../src/index";
import { placeHold, releaseHold } from "../src/ledger";
import { makeFirebaseMock, type FirebaseMock } from "./firebase-mock";

let fb: FirebaseMock;
let adminToken: string;

beforeAll(async () => {
  fb = await makeFirebaseMock("test-project");
  fetchMock.activate();
  fetchMock.disableNetConnect();
  fetchMock
    .get("https://www.googleapis.com")
    .intercept({ path: "/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com" })
    .reply(200, JSON.stringify(fb.jwks), {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    })
    .persist();
  adminToken = await fb.tokenFor({ sub: "uid-adnan", email: "adnan@thothica.com" });
});

describe("admin statement", () => {
  it("returns the full ledger for one user, newest first", async () => {
    // allocate 10 credits via the API, then hold and release 0.7 directly
    await app.request(
      "/api/admin/credits",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${adminToken}`, "content-type": "application/json" },
        body: JSON.stringify({ email: "stmt@test.dev", credits: 10, note: "start" }),
      },
      env
    );
    const user = await env.DB.prepare("SELECT id FROM users WHERE email = 'stmt@test.dev'").first<{ id: number }>();
    const hold = await placeHold(env.DB, { userId: user!.id, jobId: "job-s", amountMcr: 700 });
    if (!hold.ok) throw new Error("setup failed");
    await releaseHold(env.DB, hold.holdId);

    const res = await app.request(
      `/api/admin/users/${user!.id}/ledger`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
      env
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { kind: string; amountMcr: number; jobId: string | null; note: string | null }[];
    };
    expect(body.entries.map((e) => e.kind)).toEqual(["release", "hold", "allocation"]);
    expect(body.entries[0].amountMcr).toBe(700);
    expect(body.entries[1].amountMcr).toBe(-700);
    expect(body.entries[2].amountMcr).toBe(10_000);
  });

  it("404s for an unknown user id", async () => {
    const res = await app.request(
      "/api/admin/users/999999/ledger",
      { headers: { Authorization: `Bearer ${adminToken}` } },
      env
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd cloud/worker && npx vitest run test/admin-statement.test.ts`
Expected: FAIL (404 because the route does not exist; the second test will pass by accident, the first must fail).

- [ ] **Step 3: Implement the statement route**

Append to `cloud/worker/src/routes/admin.ts`:

```ts
admin.get("/users/:id/ledger", async (c) => {
  const userId = Number(c.req.param("id"));
  if (!Number.isInteger(userId)) return c.json({ error: "not found" }, 404);
  const exists = await c.env.DB.prepare("SELECT id FROM users WHERE id = ?1")
    .bind(userId)
    .first<{ id: number }>();
  if (!exists) return c.json({ error: "not found" }, 404);
  const { results } = await c.env.DB.prepare(
    `SELECT kind, amount_mcr, job_id, ref_id, note, created_by, created_at
     FROM credit_ledger WHERE user_id = ?1 ORDER BY id DESC`
  )
    .bind(userId)
    .all<{
      kind: string;
      amount_mcr: number;
      job_id: string | null;
      ref_id: number | null;
      note: string | null;
      created_by: string | null;
      created_at: string;
    }>();
  return c.json({
    entries: results.map((r) => ({
      kind: r.kind,
      amountMcr: r.amount_mcr,
      jobId: r.job_id,
      refId: r.ref_id,
      note: r.note,
      createdBy: r.created_by,
      createdAt: r.created_at,
    })),
  });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd cloud/worker && npx vitest run test/admin-statement.test.ts`
Expected: 2 passed.

- [ ] **Step 5: Commit**

```bash
git add cloud/worker/src/routes/admin.ts cloud/worker/test/admin-statement.test.ts
git commit -m "feat(saas): admin per-user ledger statement"
```

---

### Task 9: Frontend shell served by the Worker

**Files:**
- Create: `cloud/frontend/index.html`
- Create: `cloud/frontend/shell.css`

The full branded UI (login, dashboard, admin) arrives with later plans using the thothica-brand and frontend-design skills. This shell proves asset serving end to end and states the product name. It must carry the real palette, not invented colors.

- [ ] **Step 1: Extract the existing console palette**

Run: `grep -A 40 ':root' "src/pdf2fxl/web/static/app.css" | head -50`

Copy the CSS custom property block (`--...` color and font variables) from the output; it is pasted into `shell.css` in the next step so the shell uses the exact brand palette already shipped in the console.

- [ ] **Step 2: Create the shell**

`cloud/frontend/shell.css` (the `:root` block comes verbatim from Step 1; the rest as written):

```css
/* :root palette: PASTE the :root block from src/pdf2fxl/web/static/app.css here. */

* { box-sizing: border-box; margin: 0; }

body {
  min-height: 100vh;
  display: grid;
  place-items: center;
  background: var(--cream, #faf6ee);
  color: var(--ink, #2b2118);
  font-family: Georgia, 'Times New Roman', serif;
  padding: 24px;
}

main { text-align: center; max-width: 28rem; }

h1 { font-size: 2rem; font-weight: 500; letter-spacing: 0.01em; }

p { margin-top: 0.75rem; line-height: 1.6; opacity: 0.8; }

.status {
  margin-top: 2rem;
  font-size: 0.85rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
```

`cloud/frontend/index.html`:

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Thothica OCR</title>
  <link rel="stylesheet" href="/shell.css">
</head>
<body>
  <main>
    <h1>Thothica OCR</h1>
    <p>Clean digital editions from any scan. Sign in is opening soon.</p>
    <p class="status" id="status">checking service</p>
  </main>
  <script>
    fetch('/api/health')
      .then((r) => r.json())
      .then((b) => { document.getElementById('status').textContent = b.ok ? 'service online' : 'service degraded'; })
      .catch(() => { document.getElementById('status').textContent = 'service offline'; });
  </script>
</body>
</html>
```

- [ ] **Step 3: Verify locally**

Run: `cd cloud/worker && npx wrangler dev` (then in another shell) `curl -s http://127.0.0.1:8787/api/health && curl -s http://127.0.0.1:8787/ | head -5`
Expected: `{"ok":true}` and the HTML shell. Stop wrangler dev after.

- [ ] **Step 4: White label lint**

Run: `grep -riE 'mistral|pdf2fxl|—|–' cloud/frontend/ && echo "FAIL: found banned strings" || echo "clean"`
Expected: `clean`.

- [ ] **Step 5: Commit**

```bash
git add cloud/frontend
git commit -m "feat(saas): branded frontend shell served via Workers Assets"
```

---

### Task 10: Provision D1 and deploy to workers.dev

Invoke the `wrangler` skill before this task (repo rule: skills first). All commands run from `cloud/worker/`.

**Files:**
- Modify: `cloud/worker/wrangler.jsonc` (real database_id)

- [ ] **Step 1: Confirm wrangler auth**

Run: `npx wrangler whoami`
Expected: logged in, account id `463bdbff3b53cfdd017602e4598b4de2`. If a scope error appears on any later step, run `npx wrangler login` once and retry.

- [ ] **Step 2: Create the production D1 database**

Run: `npx wrangler d1 create thothica-ocr`
Expected output includes a `database_id` UUID. Replace `FILLED-IN-BY-TASK-10-STEP-2` in `wrangler.jsonc` with that UUID.

- [ ] **Step 3: Apply migrations remotely**

Run: `npx wrangler d1 migrations apply thothica-ocr --remote`
Expected: `0001_init.sql` applied.

- [ ] **Step 4: Deploy**

Run: `npx wrangler deploy`
Expected: deployed to `https://thothica-ocr.<account-subdomain>.workers.dev`. Note the URL.

- [ ] **Step 5: Verify the deployment end to end**

Run (substitute the real URL):

```bash
curl -s https://thothica-ocr.<account-subdomain>.workers.dev/api/health
curl -s https://thothica-ocr.<account-subdomain>.workers.dev/api/config
curl -s https://thothica-ocr.<account-subdomain>.workers.dev/ | head -5
curl -s -o /dev/null -w '%{http_code}\n' https://thothica-ocr.<account-subdomain>.workers.dev/api/me
```

Expected: `{"ok":true}`; config JSON with `"productName":"Thothica OCR"` (firebaseProjectId null until the Firebase project is wired); the HTML shell; `401` for /api/me without a token.

- [ ] **Step 6: Run the full suite one last time**

Run: `npm test` (in `cloud/worker/`) and `cd ../.. && .venv/bin/python -m pytest -q -m 'not slow'`
Expected: worker suite green; engine suite still 82 passed (untouched).

- [ ] **Step 7: Commit**

```bash
git add cloud/worker/wrangler.jsonc
git commit -m "chore(saas): provision D1 and deploy worker skeleton to workers.dev"
```

---

## Not in this plan (deferred to plans 2 to 7)

Jobs table and job routes, R2 buckets and lifecycle rules, Queues, the Python container, Mistral batch and express OCR, email, the real login/dashboard/admin UI (Firebase web config needed first: `firebase login --reauth`), bulk, retention sweeps, ocrwithai.com domain cutover.
