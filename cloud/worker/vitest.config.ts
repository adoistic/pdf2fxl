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
              // Present so the enrichment add-on's secret gate is satisfied;
              // availability still needs a non-empty enrich_model config row.
              OPENROUTER_API_KEY: "test-openrouter-key",
              // Dummy R2 creds so the direct-to-R2 (presigned) path is exercised.
              R2_ACCOUNT_ID: "testacct",
              R2_ACCESS_KEY_ID: "AKIATEST",
              R2_SECRET_ACCESS_KEY: "testsecret",
            },
          },
        },
      },
    },
  };
});
