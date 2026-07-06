import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// OpenNext → Cloudflare Workers adapter config for the Bowtie AI Content Tool
// frontend (free-plan, workers-native deployment).
//
// This UI is effectively a client-rendered SPA: TanStack Query talks to the
// backend Worker over the `/api/*` rewrite (REST) and opens SSE streams
// directly against it. There is no ISR / `'use cache'` surface that needs a
// real (writable) incremental cache — so the prerender data is served from the
// read-only, build-time static-assets cache (no R2/KV/DO bindings), and
// `enableCacheInterception` lets requests that reach the Next handler (e.g.
// RSC client-nav) answer from that cache WITHOUT loading the full NextServer —
// a per-request CPU win on the free plan's 10ms cap. Incompatible with PPR;
// revisit if PPR or revalidated routes are ever introduced.
// (Most document requests never get here at all — worker-entry.mjs serves
// prerendered HTML straight from ASSETS; see web/worker-entry.mjs.)
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
  enableCacheInterception: true,
});
