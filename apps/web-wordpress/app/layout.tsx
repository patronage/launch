import { FontLinks, navLinkClass, SiteFooter, SiteHeader } from "@launch/ui";
import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { getLayout } from "@/lib/wordpress/layout";

import "./globals.css";

export const generateMetadata = async (): Promise<Metadata> => {
  const { siteTitle, tagline } = await getLayout();

  return {
    description: tagline,
    title: { default: siteTitle, template: `%s | ${siteTitle}` },
  };
};

const RootLayout = async ({ children }: { children: ReactNode }) => {
  const { siteTitle, tagline, menu } = await getLayout();

  return (
    <html lang="en">
      <head>
        <FontLinks />
      </head>
      <body className="flex min-h-svh flex-col">
        <SiteHeader
          brand={<Link href="/">{siteTitle}</Link>}
          nav={menu.map((item) => (
            <Link
              className={navLinkClass}
              href={item.uri ?? "/"}
              key={item.id}
              target={item.target ?? undefined}
            >
              {item.label}
            </Link>
          ))}
        />
        <main className="flex-1">{children}</main>
        <SiteFooter>
          <span>{siteTitle}</span>
          {tagline ? <span>{tagline}</span> : null}
        </SiteFooter>
      </body>
    </html>
  );
};

export default RootLayout;
