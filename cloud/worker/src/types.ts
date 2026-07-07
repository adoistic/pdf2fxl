export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  STORE: R2Bucket;
  OCR_ENGINE: DurableObjectNamespace;
  OCR_QUEUE: Queue<{ jobId: string }>;
  MISTRAL_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  ADMIN_EMAIL: string;
  // OpenRouter key for the emphasis enrichment add-on. Optional: unset disables
  // the add-on (the checkbox is hidden and enrich=1 is rejected).
  OPENROUTER_API_KEY?: string;
  // R2 API token secrets for presigned direct-to-R2 URLs. Optional: when unset,
  // the app falls back to streaming bytes through the Worker (still lightweight).
  R2_ACCOUNT_ID?: string;
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
}

export interface AppUser {
  id: number;
  uid: string | null;
  email: string;
  name: string | null;
  isAdmin: boolean;
}
