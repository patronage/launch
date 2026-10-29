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
  const { siteTitle, menu } = await getLayout();

  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="site-title">
            {siteTitle}
          </Link>
          <nav aria-label="Primary">
            {menu.map((item) => (
              <Link
                key={item.id}
                href={item.uri ?? "/"}
                target={item.target ?? undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
};

export default RootLayout;
