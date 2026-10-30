import type { ReactNode } from "react";

import { cn } from "../utils";
import { Container } from "./container";

/**
 * Site header shell. Apps pass their own links (next/link or plain anchors),
 * so the shell stays framework-free; style them with `navLinkClass`.
 */
export const SiteHeader = ({
  actions,
  brand,
  nav,
}: {
  actions?: ReactNode;
  brand: ReactNode;
  nav?: ReactNode;
}) => (
  <header
    className="bg-background/85 supports-backdrop-filter:bg-background/70 sticky top-0 z-40 border-b backdrop-blur"
    data-skin="light"
  >
    <Container className="flex min-h-16 flex-wrap items-center gap-x-8 gap-y-2 py-3">
      <div className="font-display text-lg font-semibold tracking-tight">
        {brand}
      </div>
      {nav ? (
        <nav
          aria-label="Primary"
          className="flex flex-wrap items-center gap-x-6 gap-y-1"
        >
          {nav}
        </nav>
      ) : null}
      {actions ? (
        <div className="ms-auto flex items-center gap-3">{actions}</div>
      ) : null}
    </Container>
  </header>
);

export const navLinkClass = cn(
  "text-muted-foreground hover:text-foreground text-sm font-medium transition-colors"
);

export const SiteFooter = ({ children }: { children?: ReactNode }) => (
  <footer className="bg-muted border-t" data-skin="light">
    <Container className="text-muted-foreground flex flex-wrap items-center justify-between gap-4 py-10 text-sm">
      {children}
    </Container>
  </footer>
);

const FONT_STYLESHEET =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400..700&family=JetBrains+Mono:wght@400;500&display=swap";

/**
 * Loads the faces tokens.css names (Inter, JetBrains Mono). Render it in the
 * document <head>; a site with its own fonts drops it and sets --typeface-*.
 */
export const FontLinks = () => (
  <>
    <link href="https://fonts.googleapis.com" rel="preconnect" />
    <link crossOrigin="" href="https://fonts.gstatic.com" rel="preconnect" />
    <link href={FONT_STYLESHEET} rel="stylesheet" />
  </>
);
