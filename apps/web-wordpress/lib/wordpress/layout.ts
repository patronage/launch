import { cache } from "react";

import { wpQuery } from "./client";
import { LayoutQuery } from "./queries";

export const getLayout = cache(async () => {
  const { generalSettings, menuItems } = await wpQuery(LayoutQuery, {});

  return {
    menu: (menuItems?.nodes ?? []).filter((item) => item.uri),
    siteTitle: generalSettings?.title ?? "",
    tagline: generalSettings?.description ?? "",
  };
});
