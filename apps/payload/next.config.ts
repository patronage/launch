import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";

// vinext reads this file. It ignores options that only apply to webpack or Turbopack.
const nextConfig: NextConfig = {
  images: {
    localPatterns: [{ pathname: "/api/media/file/**" }],
  },
};

export default withPayload(nextConfig);
