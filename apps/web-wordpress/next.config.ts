import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // WordPress URIs end in a slash; matching them keeps paths and cache keys identical.
  trailingSlash: true,
};

export default nextConfig;
