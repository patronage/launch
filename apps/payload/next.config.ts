import { withPayload } from "@payloadcms/next/withPayload";
import type { NextConfig } from "next";

// vinext reads this file. It ignores options that only apply to webpack or Turbopack.
const nextConfig: NextConfig = {
  // Metadata streams into <body> except for user agents matched here. Match
  // all of them: crawlers that only read HTML need it in <head>, and these
  // dynamic pages read the same data for their body anyway.
  htmlLimitedBots: /.*/u,
  images: {
    localPatterns: [{ pathname: "/api/media/file/**" }],
  },
};

export default withPayload(nextConfig);
