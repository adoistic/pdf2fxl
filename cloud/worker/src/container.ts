import { Container } from "@cloudflare/containers";
import type { Env } from "./types";

// The engine container: FastAPI on :8000, pure compute. One named instance
// ("engine") is enough for plan 2a; scaling comes with the batch pipeline.
export class OcrEngine extends Container<Env> {
  defaultPort = 8000;
  sleepAfter = "10m";
}
