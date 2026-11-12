import type { MetadataRoute } from "next";

import { robotsRules, siteOrigin } from "@/lib/seo";

export const dynamic = "force-dynamic";

const robots = async (): Promise<MetadataRoute.Robots> =>
  robotsRules(await siteOrigin());

export default robots;
