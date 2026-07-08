// One queue carries OCR jobs, translations, and delayed upload cleanups;
// exactly one id is set per message.
export type QueueMsg = { jobId?: string; translationId?: string; cleanupJobId?: string };

export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  STORE: R2Bucket;
  OCR_ENGINE: DurableObjectNamespace;
  OCR_QUEUE: Queue<QueueMsg>;
  MISTRAL_API_KEY: string;
  FIREBASE_PROJECT_ID: string;
  ADMIN_EMAIL: string;
  // API key for the hosted vision model behind the emphasis enrichment add-on.
  // Optional: unset disables the add-on (checkbox hidden, enrich=1 rejected).
  // Provider-neutral by name so the integration stays white-labeled.
  ENRICH_API_KEY?: string;
  // API key for the hosted model behind the translation add-on. Optional:
  // when unset it falls back to ENRICH_API_KEY (same provider account);
  // when neither is set the add-on is invisible end to end.
  TRANSLATE_API_KEY?: string;
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
