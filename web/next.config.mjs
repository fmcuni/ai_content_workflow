import { execSync } from "node:child_process";

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

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server build for the desktop (Tauri) frontend sidecar.
  output: "standalone",
  // Root the file-tracing at this web dir so standalone output lands at
  // .next/standalone/server.js. Without this, the repo's parent lockfiles make
  // Next root the trace higher up and nest server.js under the repo path.
  outputFileTracingRoot: import.meta.dirname,
  env: {
    NEXT_PUBLIC_BUILD_SHA: gitSha(),
    NEXT_PUBLIC_BUILD_DATE: buildDate(),
  },
  async rewrites() {
    return [
      // Exact rule first so POST /api/setup maps to /setup (not /setup/, which
      // would 307-redirect and risk dropping the POST body).
      { source: "/api/setup", destination: `${apiBase}/setup` },
      { source: "/api/setup/:path*", destination: `${apiBase}/setup/:path*` },
      { source: "/api/runs/:path*", destination: `${apiBase}/runs/:path*` },
      { source: "/api/costs/:path*", destination: `${apiBase}/costs/:path*` },
      { source: "/api/health", destination: `${apiBase}/health` },
      { source: "/api/articles/:path*", destination: `${apiBase}/articles/:path*` },
      { source: "/api/refresh/:path*", destination: `${apiBase}/refresh/:path*` },
      { source: "/api/wp-options/:path*", destination: `${apiBase}/wp-options/:path*` },
      { source: "/api/personas/:path*", destination: `${apiBase}/personas/:path*` },
      { source: "/api/prompts/:path*", destination: `${apiBase}/prompts/:path*` },
      { source: "/api/topic-batches/:path*", destination: `${apiBase}/topic-batches/:path*` },
    ];
  },
};
export default nextConfig;
