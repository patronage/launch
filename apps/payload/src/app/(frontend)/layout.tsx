import { FontLinks, navLinkClass, SiteFooter, SiteHeader } from "@launch/ui";
import Link from "next/link";
import type { ReactNode } from "react";

import { getFrontendPayload } from "@/lib/payload";
import { NEWS_PATH } from "@/lib/posts";

import "./styles.css";

export const generateMetadata = async () => {
  const { payload, user } = await getFrontendPayload();

  const { siteName, tagline } = await payload.findGlobal({
    overrideAccess: false,
    slug: "site-settings",
    user,
  });

  return {
    description: tagline ?? undefined,
    title: { default: siteName, template: `%s | ${siteName}` },
  };
};

const RootLayout = async ({ children }: { children: ReactNode }) => {
  const { payload, user } = await getFrontendPayload();

  const settings = await payload.findGlobal({
    overrideAccess: false,
    slug: "site-settings",
    user,
  });

  return (
    <html lang="en">
      <head>
        <FontLinks />
      </head>
      <body className="flex min-h-svh flex-col">
        <SiteHeader
          actions={
            <a className={navLinkClass} href="/admin">
              {user ? `Admin (${user.email})` : "Admin"}
            </a>
          }
          brand={<Link href="/">{settings.siteName}</Link>}
          nav={
            <Link className={navLinkClass} href={NEWS_PATH}>
              News
            </Link>
          }
        />
        <main className="flex-1">{children}</main>
        <SiteFooter>
          <span>{settings.siteName}</span>
          {settings.tagline ? <span>{settings.tagline}</span> : null}
        </SiteFooter>
      </body>
    </html>
  );
};

export default RootLayout;
