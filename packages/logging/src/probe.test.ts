import { describe, expect, it, vi } from "vitest";

import { isProbePath, isProbeResponse, withProbeGuard } from "./probe.ts";

const ctx = { waitUntil: () => {} };

interface DemoEnv {
  SITE: string;
}

type Handler = (
  request: Request,
  env?: DemoEnv,
  context?: typeof ctx
) => Response;

const page = () => vi.fn<Handler>(() => new Response("page"));

const scheduled = () => {};

// Paths scanners ask every public site for. None of them is served by a
// Launch site.
const MUST_MATCH = [
  "/.env",
  "/.env.local",
  "/.env.production.bak",
  "/api/.env",
  "/%2Eenv",
  "/.git/config",
  "/.git/HEAD",
  "/assets/.git/config",
  "/.svn/entries",
  "/.hg/store",
  "/.DS_Store",
  "/.aws/credentials",
  "/.ssh/id_rsa",
  "/.htaccess",
  "/.htpasswd",
  "/.vscode/sftp.json",
  "/.idea/workspace.xml",
  "/.npmrc",
  "/.docker/config.json",
  "/wp-login.php",
  "/WP-LOGIN.PHP",
  "/xmlrpc.php",
  "/wp-admin/setup-config.php",
  "/wp-admin/install.php",
  "/wp-includes/wlwmanifest.xml/../x.php",
  "/wp-content/plugins/hello.php",
  "/index.php",
  "/index.php/wp-json/wp/v2/users",
  "/info.php",
  "/shell.php7",
  "/vendor/phpunit/phpunit/src/Util/PHP/eval-stdin.php",
  "/phpmyadmin/index.php",
  "/cgi-bin/luci",
  "/cgi-bin/",
  "/test.cgi",
  "/default.asp",
  "/login.aspx",
  "/admin.jsp",
  "/template.phtml",
];

// Paths a Launch site does or may serve: pages, the CMS media route, proxied
// WordPress uploads, well-known files, build assets, APIs and admin screens.
const MUST_NOT_MATCH = [
  "/",
  "/about",
  "/news/2026/launch",
  "/environment",
  "/envelope.svg",
  "/.well-known/security.txt",
  "/.well-known/acme-challenge/abc123",
  "/.well-known/apple-app-site-association",
  "/robots.txt",
  "/sitemap.xml",
  "/favicon.ico",
  "/_next/static/chunks/main.js",
  "/media/2026/11/photo.jpg",
  "/media/2026/11/photo.php.jpg",
  "/wp-content/uploads/2026/11/photo.jpg",
  "/wp-json/wp/v2/posts",
  "/wp-admin",
  "/graphql",
  "/admin",
  "/admin/collections/pages",
  "/api/preview",
  "/forms/submit",
  "/_emdash/admin",
  "/php-tips",
  "/php",
  "/cgi",
  "/blog/git-workflow",
  "/blog/.github-actions-notes",
  "/%E0%A4%A",
];

describe(isProbePath, () => {
  it.each(MUST_MATCH)("matches %s", (path) => {
    expect(isProbePath(path)).toBeTruthy();
  });

  it.each(MUST_NOT_MATCH)("leaves %s alone", (path) => {
    expect(isProbePath(path)).toBeFalsy();
  });

  it("lets a site allow a path on the default list", () => {
    expect(
      isProbePath("/legacy/index.php", { allow: ["/legacy/"] })
    ).toBeFalsy();
    expect(isProbePath("/legacy", { allow: ["/legacy/"] })).toBeFalsy();
    expect(isProbePath("/xmlrpc.php", { allow: ["/XMLRPC.php"] })).toBeFalsy();
    expect(
      isProbePath("/legacyx/index.php", { allow: ["/legacy/"] })
    ).toBeTruthy();
    expect(
      isProbePath("/xmlrpc.php/x", { allow: ["/xmlrpc.php"] })
    ).toBeTruthy();
  });

  it("adds a site's own paths", () => {
    const options = { extra: ["/old-admin/", "/backup.zip"] };

    expect(isProbePath("/old-admin", options)).toBeTruthy();
    expect(isProbePath("/old-admin/users", options)).toBeTruthy();
    expect(isProbePath("/BACKUP.ZIP", options)).toBeTruthy();
    expect(isProbePath("/backup.zip.txt", options)).toBeFalsy();
    expect(isProbePath("/old-administrator", options)).toBeFalsy();
  });

  it("lets allow win over extra", () => {
    expect(
      isProbePath("/old-admin/ok", {
        allow: ["/old-admin/ok"],
        extra: ["/old-admin/"],
      })
    ).toBeFalsy();
  });
});

describe(withProbeGuard, () => {
  it("answers a probe path with an empty 404 without calling the entry", async () => {
    const fetch = page();
    const entry = withProbeGuard({ fetch });

    const response = await entry.fetch(
      new Request("https://example.org/wp-login.php?redirect_to=x"),
      { SITE: "demo" },
      ctx
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe("");
    expect(response.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(isProbeResponse(response)).toBeTruthy();
  });

  it("passes other requests to the entry with its arguments", async () => {
    const env: DemoEnv = { SITE: "demo" };
    const fetch = page();

    const entry = withProbeGuard({ fetch }, { extra: ["/blocked"] });

    const request = new Request("https://example.org/about");

    const response = await entry.fetch(request, env);

    expect(fetch).toHaveBeenCalledWith(request, env);
    await expect(response.text()).resolves.toBe("page");
    expect(isProbeResponse(response)).toBeFalsy();
  });

  it("uses the site's allow and extra lists", async () => {
    const fetch = page();

    const entry = withProbeGuard(
      { fetch },
      { allow: ["/xmlrpc.php"], extra: ["/blocked"] }
    );

    const allowed = await entry.fetch(
      new Request("https://example.org/xmlrpc.php")
    );

    const blocked = await entry.fetch(
      new Request("https://example.org/blocked")
    );

    expect(allowed.status).toBe(200);
    expect(blocked.status).toBe(404);
  });

  it("calls the entry with its own this", async () => {
    const entry = withProbeGuard({
      body: "from this",
      fetch(this: { body: string }, _request: Request) {
        return new Response(this.body);
      },
    });

    const response = await entry.fetch(new Request("https://example.org/"));

    await expect(response.text()).resolves.toBe("from this");
  });

  it("keeps the entry's other handlers", () => {
    const entry = withProbeGuard({ fetch: () => new Response(), scheduled });

    expect(entry.scheduled).toBe(scheduled);
  });
});
