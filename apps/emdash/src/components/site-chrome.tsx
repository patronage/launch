import { navLinkClass, SiteFooter, SiteHeader } from "@launch/ui";
import type { ReactNode } from "react";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  newTab: boolean;
}

interface Props {
  siteTitle: string;
  tagline?: string | undefined;
  menu: NavItem[];
  children?: ReactNode;
}

/** The shared header and footer around a page, rendered on the server only. */
export const SiteChrome = ({ siteTitle, tagline, menu, children }: Props) => (
  <>
    <SiteHeader
      brand={<a href="/">{siteTitle}</a>}
      nav={menu.map((item) => (
        <a
          className={navLinkClass}
          href={item.href}
          key={item.id}
          {...(item.newTab
            ? { rel: "noopener noreferrer", target: "_blank" }
            : {})}
        >
          {item.label}
        </a>
      ))}
    />
    <main className="flex-1">{children}</main>
    <SiteFooter>
      <span>{siteTitle}</span>
      {tagline ? <span>{tagline}</span> : null}
    </SiteFooter>
  </>
);
