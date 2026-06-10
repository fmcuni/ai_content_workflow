import { execSync } from "node:child_process";

import { SECURITY_HEADERS } from "./lib/security-headers.ts";

const apiBase = process.env.NEXT_PUBLIC_API_BASE;
if (!apiBase) {
  throw new Error("NEXT_PUBLIC_API_BASE is required (copy web/.env.local.example to web/.env.local)");
}

function gitSha() {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function buildDate() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// Build target switch. The default build emits a self-contained `standalone`
// server for the desktop (Tauri) frontend sidecar. The Cloudflare Workers build
// (`npm run cf:build`, which sets WEB_BUILD_TARGET=cloudflare) must NOT use
// standalone output — the OpenNext adapter consumes the regular `.next` build
// and produces its own Worker bundle.
const isCloudflare = process.env.WEB_BUILD_TARGET === "cloudflare";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server build for the desktop (Tauri) frontend sidecar.
  // Omitted for the Cloudflare build (OpenNext bundles the Worker itself).
  output: isCloudflare ? undefined : "standalone",
  // Root the file-tracing at this web dir so standalone output lands at
  // .next/standalone/server.js. Without this, the repo's parent lockfiles make
  // Next root the trace higher up and nest server.js under the repo path.
  outputFileTracingRoot: import.meta.dirname,
  env: {
    NEXT_PUBLIC_BUILD_SHA: gitSha(),
    NEXT_PUBLIC_BUILD_DATE: buildDate(),
  },
  // Security headers (CSP + hardening) applied to EVERY response — pages,
  // assets, and `_next/*`. Single source of truth in lib/security-headers.ts;
  // OpenNext honours next.config `headers()`. See that file for the
  // script-src 'unsafe-inline' (vs nonce) rationale.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [...SECURITY_HEADERS],
      },
    ];
  },
  async rewrites() {
    // Exact (bare-collection) rules come first for every endpoint the app calls
    // without a sub-path. `:path*` matches the bare path too but emits a trailing
    // slash (`/personas/`), which the backend's router rejects (and would
    // 307-redirect a POST, dropping its body — e.g. POST /api/runs to create a run).
    return [
      // Auth (better-auth) is PATH-PRESERVING — keep the `/api` prefix so the
      // backend mount (`/api/auth/*`) and the same-origin session cookie line up.
      { source: "/api/auth/:path*", destination: `${apiBase}/api/auth/:path*` },
      // SSE ticket issuer (cookie-protected on the backend).
      { source: "/api/auth-ticket", destination: `${apiBase}/api/auth-ticket` },
      { source: "/api/setup", destination: `${apiBase}/setup` },
      { source: "/api/setup/:path*", destination: `${apiBase}/setup/:path*` },
      { source: "/api/runs", destination: `${apiBase}/runs` },
      { source: "/api/runs/:path*", destination: `${apiBase}/runs/:path*` },
      { source: "/api/costs/:path*", destination: `${apiBase}/costs/:path*` },
      { source: "/api/health", destination: `${apiBase}/health` },
      { source: "/api/articles", destination: `${apiBase}/articles` },
      { source: "/api/articles/:path*", destination: `${apiBase}/articles/:path*` },
      { source: "/api/refresh", destination: `${apiBase}/refresh` },
      { source: "/api/refresh/:path*", destination: `${apiBase}/refresh/:path*` },
      { source: "/api/wp-options/:path*", destination: `${apiBase}/wp-options/:path*` },
      { source: "/api/personas", destination: `${apiBase}/personas` },
      { source: "/api/personas/:path*", destination: `${apiBase}/personas/:path*` },
      { source: "/api/publish-targets", destination: `${apiBase}/publish-targets` },
      { source: "/api/publish-targets/:path*", destination: `${apiBase}/publish-targets/:path*` },
      { source: "/api/prompts", destination: `${apiBase}/prompts` },
      { source: "/api/prompts/:path*", destination: `${apiBase}/prompts/:path*` },
      { source: "/api/source-policy", destination: `${apiBase}/source-policy` },
      { source: "/api/source-policy/:path*", destination: `${apiBase}/source-policy/:path*` },
      { source: "/api/topic-batches", destination: `${apiBase}/topic-batches` },
      { source: "/api/topic-batches/:path*", destination: `${apiBase}/topic-batches/:path*` },
      // Current-user role (RBAC) + admin user-management. Bare `/api/me` is an
      // exact rule (no trailing slash); `/api/admin/:path*` covers the user list
      // and the per-user role PUT.
      { source: "/api/me", destination: `${apiBase}/me` },
      { source: "/api/admin/:path*", destination: `${apiBase}/admin/:path*` },
    ];
  },
};
export default nextConfig;

// Wire local Cloudflare bindings into `next dev` so server code can read them
// during development. Inert in production builds; guarded to dev so it never
// touches the Tauri `standalone` build.
if (process.env.NODE_ENV !== "production") {
  const { initOpenNextCloudflareForDev } = await import("@opennextjs/cloudflare");
  initOpenNextCloudflareForDev();
}
