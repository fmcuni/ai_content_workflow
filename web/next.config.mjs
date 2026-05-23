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
  env: {
    NEXT_PUBLIC_BUILD_SHA: gitSha(),
    NEXT_PUBLIC_BUILD_DATE: buildDate(),
  },
  async rewrites() {
    return [
      { source: "/api/runs/:path*", destination: `${apiBase}/runs/:path*` },
      { source: "/api/costs/:path*", destination: `${apiBase}/costs/:path*` },
      { source: "/api/health", destination: `${apiBase}/health` },
      { source: "/api/articles/:path*", destination: `${apiBase}/articles/:path*` },
      { source: "/api/refresh/:path*", destination: `${apiBase}/refresh/:path*` },
    ];
  },
};
export default nextConfig;
