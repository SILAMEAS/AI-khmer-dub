import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // msedge-tts opens WebSockets with Node APIs; load it from node_modules instead of bundling (and the proxy
  // packages of lib/net.ts with it: undici has to be the one Node's fetch() reads its proxy setting from)
  serverExternalPackages: ["msedge-tts", "undici", "https-proxy-agent"],
  turbopack: { root: __dirname },
};

export default nextConfig;
