export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  STORE: R2Bucket;
  OCR_ENGINE: DurableObjectNamespace;
  OCR_QUEUE: Queue<{ jobId: string }>;
  MISTRAL_API_KEY: string;
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
