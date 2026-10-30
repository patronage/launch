import Link from "next/link";
import type { ReactNode } from "react";

import { getFrontendPayload } from "@/lib/payload";

import "@launch/ui/tokens.css";
import "@launch/ui/sections.css";
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
      <body>
        <header className="site-header">
          <Link className="site-title" href="/">
            {settings.siteName}
          </Link>
          {settings.tagline && (
            <span className="site-tagline">{settings.tagline}</span>
          )}
          <a className="site-admin" href="/admin">
            {user ? `Admin (${user.email})` : "Admin"}
          </a>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
};

export default RootLayout;
