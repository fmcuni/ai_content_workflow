const apiBase = process.env.NEXT_PUBLIC_API_BASE;
if (!apiBase) {
  throw new Error("NEXT_PUBLIC_API_BASE is required (copy web/.env.local.example to web/.env.local)");
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/runs/:path*", destination: `${apiBase}/runs/:path*` },
      { source: "/api/costs/:path*", destination: `${apiBase}/costs/:path*` },
      { source: "/api/health", destination: `${apiBase}/health` },
    ];
  },
};
export default nextConfig;
