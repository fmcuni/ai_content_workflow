import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// OpenNext → Cloudflare Workers adapter config for the Bowtie AI Content Tool
// frontend (free-plan, workers-native deployment).
//
// This UI is effectively a client-rendered SPA: TanStack Query talks to the
// backend Worker over the `/api/*` rewrite (REST) and opens SSE streams
// directly against it. There is no ISR / `'use cache'` surface that needs a
// real incremental cache, so we run with defaults — no R2 bucket, KV namespace,
// or DO queue bindings required. Add an incremental-cache override here only if
// server-rendered, revalidated routes are introduced later.
export default defineCloudflareConfig();
