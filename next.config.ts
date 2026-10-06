import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // msedge-tts opens WebSockets with Node APIs; load it from node_modules instead of bundling
  serverExternalPackages: ["msedge-tts"],
  turbopack: { root: __dirname },
};

export default nextConfig;
