import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  typescript: {
    ignoreBuildErrors: true,
  },
  reactStrictMode: false,
  // Proxy collector requests through Next.js (no Caddy needed).
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        has: [{ type: "query", key: "XTransformPort", value: "3001" }],
        destination: "http://localhost:3001/api/:path*",
      },
      {
        source: "/socket.io/:path*",
        has: [{ type: "query", key: "XTransformPort", value: "3001" }],
        destination: "http://localhost:3001/socket.io/:path*",
      },
    ];
  },
};

export default nextConfig;
