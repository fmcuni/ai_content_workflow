/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    return [
      { source: "/api/runs/:path*", destination: `${process.env.NEXT_PUBLIC_API_BASE}/runs/:path*` },
      { source: "/api/health", destination: `${process.env.NEXT_PUBLIC_API_BASE}/health` },
    ];
  },
};
export default nextConfig;
