// Scripted browser drives for launch-verify, on the repo's own Playwright (the
// one apps/payload's smoke test uses). verify.ts calls these; each writes a
// transcript, numbered screenshots and any side-effect proof to its evidence
// directory.
//
// Each drive is one user's path, step by step, so awaiting inside loops is
// the point here, not an accident.
/* oxlint-disable no-await-in-loop */
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

import type { Browser, BrowserType, Page } from "playwright";

export interface DriveContext {
  origin: string;
  dir: string;
  repoRoot: string;
  /** The origin of each surface this checkout runs, by surface name. */
  peers: Record<string, string | undefined>;
  /** Signs an Access JWT for a synthetic editor with the local stand-in. */
  signIn: (email: string) => string;
}

export type Drive = (context: DriveContext) => Promise<void>;

const openBrowser = (repoRoot: string) => {
  const require = createRequire(
    path.join(repoRoot, "apps/payload/package.json")
  );

  const { chromium }: { chromium: BrowserType } = require("playwright");

  return chromium.launch({
    executablePath: process.env.VERIFY_CHROMIUM || undefined,
  });
};

/** Records each user action beside what was observed, as transcript.md. */
const transcript = (dir: string) => {
  const lines = ["# Drive transcript", ""];
  let shot = 0;

  return {
    async shot(page: Page, name: string) {
      shot += 1;
      const file = `${String(shot).padStart(2, "0")}-${name}.png`;

      await page.screenshot({ fullPage: true, path: path.join(dir, file) });
      lines.push(`  - screenshot: ${file}`);
    },
    step(action: string, observed: string) {
      lines.push(`- **${action}**: ${observed}`);
    },
    write() {
      writeFileSync(path.join(dir, "transcript.md"), `${lines.join("\n")}\n`);
    },
  };
};

/**
 * Payload: a visitor sends the garden application on /apply, sees the
 * confirmation, and the submission is stored (read back as the local admin).
 */
const payloadApplyForm: Drive = async ({ origin, dir, repoRoot }) => {
  const marker = `verify-${randomUUID().slice(0, 8)}`;
  const log = transcript(dir);
  const browser = await openBrowser(repoRoot);

  try {
    const page = await browser.newPage({
      viewport: { height: 900, width: 1280 },
    });

    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    await page.goto(`${origin}/apply`, { waitUntil: "networkidle" });
    const submit = page.getByRole("button", { name: "Send application" });

    await submit.waitFor();
    log.step("Open /apply", `form shows "${await submit.textContent()}"`);
    await log.shot(page, "form");

    await page.fill('[name="name"]', `Verify ${marker}`);
    await page.fill('[name="email"]', `${marker}@example.test`);
    await page.fill('[name="lotAddress"]', "100 Example Street");

    for (const name of ["neighborhood", "neighbors"]) {
      const select = page.locator(`select[name="${name}"]`);

      const values = await select
        .locator("option")
        .evaluateAll((options) =>
          options
            .map((option) => option.getAttribute("value") ?? "")
            .filter(Boolean)
        );

      await select.selectOption(values[0] ?? "");
    }

    await page.fill(
      '[name="about"]',
      `Synthetic application from launch-verify run ${marker}.`
    );
    await page.check('[name="permission"]');
    log.step("Fill every field with synthetic data", `run marker ${marker}`);
    await log.shot(page, "filled");

    const posted = page.waitForResponse((response) =>
      response.url().endsWith("/forms/submit")
    );

    await submit.click();
    const response = await posted;
    const confirmation = page.locator("output");

    await confirmation.waitFor();
    const confirmationText = await confirmation.textContent();

    log.step(
      "Click Send application",
      `POST /forms/submit -> ${response.status()}; confirmation: "${confirmationText.trim()}"`
    );
    await log.shot(page, "confirmation");

    // The side effect: sign in as the local admin and read the stored row.
    // A fresh local database has no users: create the synthetic local admin
    // the way an editor would. Otherwise use the localhost-only "Continue as".
    await page.goto(`${origin}/admin`, { waitUntil: "networkidle" });

    const continueAs = page.getByRole("button", { name: /^Continue as /u });

    if (await page.locator("#field-confirm-password").isVisible()) {
      const password = randomUUID();

      await page.fill("#field-email", "verify@example.test");
      await page.fill("#field-password", password);
      await page.fill("#field-confirm-password", password);
      await page.click("button[type=submit]");
      await page.waitForURL(
        (url) => !url.pathname.includes("create-first-user")
      );
      log.step(
        "Create the first local admin",
        "verify@example.test (no users existed)"
      );
    } else if (await continueAs.isVisible()) {
      await continueAs.click();
      await page.waitForLoadState("networkidle");
      log.step("Click Continue as …", "signed in as the first local admin");
    }

    const stored = await page.request.get(
      `${origin}/api/form-submissions?depth=0&limit=10&sort=-createdAt`
    );

    const body: {
      docs?: {
        id: number;
        submissionData?: { field: string; value: string }[];
      }[];
    } = await stored.json();

    const row = body.docs?.find((doc) =>
      doc.submissionData?.some((entry) => entry.value.includes(marker))
    );

    writeFileSync(
      path.join(dir, "form-submissions.json"),
      `${JSON.stringify(row ?? body, null, 2)}\n`
    );
    log.step(
      "Read /api/form-submissions as the local admin",
      row
        ? `stored as submission ${row.id}`
        : `NOT FOUND (status ${stored.status()})`
    );

    await page.goto(`${origin}/admin/collections/form-submissions`, {
      waitUntil: "networkidle",
    });
    await log.shot(page, "admin-submissions");

    log.step(
      "Browser console errors",
      errors.length ? errors.join(" | ") : "none"
    );

    if (!(response.ok() && row)) {
      throw new Error("apply-form failed: see transcript.md");
    }
  } finally {
    log.write();
    await browser.close();
  }
};

/** A redirect as Payload's REST API takes it. */
interface RedirectInput {
  from: string;
  to:
    | { type: "custom"; url: string }
    | {
        reference: { relationTo: "posts"; value: number | undefined };
        type: "reference";
      };
  type: "307" | "308";
}

const custom = (url: string) => ({ type: "custom", url }) as const;

/**
 * Payload: what search engines and visitors get from the SEO fields and
 * redirects, then an editor adding a redirect in the admin. Needs the seed and
 * a local admin (`drive payload apply-form`). It deletes the redirects it adds.
 */
const payloadSeo: Drive = async ({ origin, dir, repoRoot }) => {
  const log = transcript(dir);
  const browser = await openBrowser(repoRoot);
  const failures: string[] = [];

  const expectThat = (action: string, observed: string, passed: boolean) => {
    log.step(action, `${passed ? "" : "FAILED: "}${observed}`);

    if (!passed) {
      failures.push(action);
    }
  };

  /** One anonymous request that doesn't follow redirects. */
  const visit = async (pathname: string) => {
    const response = await fetch(`${origin}${pathname}`, {
      redirect: "manual",
    });

    return {
      body: await response.text(),
      location: response.headers.get("location") ?? "",
      status: response.status,
    };
  };

  const expectRedirect = async (
    from: string,
    status: number,
    location: string
  ) => {
    const result = await visit(from);

    expectThat(
      `Request ${from}`,
      `${result.status} to ${result.location}`,
      result.status === status && result.location === location
    );
  };

  const expectStatus = async (
    action: string,
    pathname: string,
    status: number
  ) => {
    const result = await visit(pathname);

    expectThat(
      action,
      `${pathname} -> ${result.status}`,
      result.status === status
    );
  };

  try {
    const context = await browser.newContext({
      viewport: { height: 900, width: 1280 },
    });

    const page = await context.newPage();

    await expectRedirect("/seeds", 308, "/programs/seed-library");
    await expectRedirect("/2024/05/tool-library", 308, "/programs/tool-share");
    await expectStatus("Request an unknown path", "/no-such-page", 404);

    await page.goto(`${origin}/programs/seed-library`, {
      waitUntil: "networkidle",
    });

    const title = await page.title();
    const titles = await page.locator("head title").count();

    const canonical = await page
      .locator('link[rel="canonical"]')
      .getAttribute("href");

    const image = await page
      .locator('meta[property="og:image"]')
      .getAttribute("content");

    expectThat(
      "Read the seed library's head",
      `${titles} title: "${title}", canonical ${canonical}, image ${image}`,
      titles === 1 &&
        title === "Free seed library for neighbors" &&
        canonical === `${origin}/programs/seed-library` &&
        Boolean(image?.startsWith(`${origin}/media/`))
    );
    await log.shot(page, "seed-library");

    const socialImage = await fetch(image ?? "");

    expectThat(
      "Fetch the social image anonymously",
      `${socialImage.status} ${socialImage.headers.get("content-type")}`,
      socialImage.ok
    );

    const hidden = await visit("/programs/tool-share");

    expectThat(
      "Read a hidden page's head",
      "robots meta present",
      /<meta name="robots" content="[^"]*noindex/u.test(hidden.body)
    );

    const sitemap = await visit("/sitemap.xml");

    writeFileSync(path.join(dir, "sitemap.xml"), sitemap.body);
    expectThat(
      "Read /sitemap.xml",
      `${sitemap.status}, saved as sitemap.xml`,
      sitemap.status === 200 &&
        sitemap.body.includes(`${origin}/programs/seed-library<`) &&
        sitemap.body.includes(`${origin}/news/how-to-save-seed<`) &&
        !sitemap.body.includes("tool-share") &&
        !sitemap.body.includes("hiring-youth-coordinator")
    );

    const robots = await visit("/robots.txt");

    expectThat(
      "Read /robots.txt",
      robots.body.replaceAll("\n", " | "),
      robots.body.includes("Disallow: /admin/") &&
        robots.body.includes(`Sitemap: ${origin}/sitemap.xml`)
    );

    await page.goto(`${origin}/admin`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /^Continue as /u }).click();
    await page.waitForLoadState("networkidle");
    log.step("Click Continue as …", "signed in as the first local admin");

    const created: number[] = [];

    /** Adds a redirect over REST as the signed-in editor. */
    const addRedirect = async (data: RedirectInput) => {
      const response = await page.request.post(`${origin}/api/redirects`, {
        data,
      });

      const body: { doc?: { id: number } } = await response.json();

      if (body.doc) {
        created.push(body.doc.id);
      }

      return response.status();
    };

    try {
      await page.goto(`${origin}/admin/collections/redirects/create`, {
        waitUntil: "networkidle",
      });
      await page.fill("#field-from", "not-a-path");
      await page.getByText("Custom URL", { exact: true }).first().click();
      await page.fill("#field-to__url", "https://example.test/moved");
      await page.click("#action-save");
      await page.getByText("starts with one /").first().waitFor();
      log.step("Save a redirect without a leading /", "the form refuses it");
      await log.shot(page, "redirect-invalid");

      await page.fill("#field-from", "/verify-moved");
      await page.click("#action-save");
      await page.waitForURL(/\/redirects\/\d+/u);
      created.push(Number(page.url().split("/").at(-1)));
      log.step("Save it with /verify-moved", `created at ${page.url()}`);
      await log.shot(page, "redirect-saved");
      await expectRedirect("/verify-moved", 308, "https://example.test/moved");

      await addRedirect({
        from: "/verify-temporary",
        to: custom("/news"),
        type: "307",
      });
      await expectRedirect("/verify-temporary", 307, "/news");

      await addRedirect({
        from: "/guide",
        to: custom("/apply"),
        type: "308",
      });
      await expectStatus("A published page beats a redirect", "/guide", 200);

      await addRedirect({
        from: "/verify-self",
        to: custom("/verify-self/"),
        type: "308",
      });
      await expectStatus("A self-redirect is ignored", "/verify-self", 404);

      await addRedirect({
        from: "/news/verify-old-post",
        to: custom("/news"),
        type: "308",
      });
      await expectRedirect("/news/verify-old-post", 308, "/news");

      const drafts = await page.request.get(
        `${origin}/api/posts?draft=true&depth=0&where[slug][equals]=hiring-youth-coordinator`
      );

      const { docs }: { docs: { id: number }[] } = await drafts.json();

      await addRedirect({
        from: "/verify-draft",
        to: {
          reference: { relationTo: "posts", value: docs[0]?.id },
          type: "reference",
        },
        type: "308",
      });
      await expectStatus(
        "A redirect to a draft is ignored",
        "/verify-draft",
        404
      );

      await page.goto(`${origin}/admin/collections/pages`, {
        waitUntil: "networkidle",
      });
      await page.getByRole("link", { name: "Seed library" }).first().click();
      await page.locator("#field-meta__title").waitFor();
      await page.locator("#field-meta__title").scrollIntoViewIfNeeded();
      expectThat(
        "Open the page's SEO group",
        `title field holds "${await page.inputValue("#field-meta__title")}"`,
        (await page.inputValue("#field-meta__title")) ===
          "Free seed library for neighbors"
      );
      await log.shot(page, "admin-seo-fields");
    } finally {
      for (const id of created) {
        await page.request.delete(`${origin}/api/redirects/${id}`);
      }

      log.step("Delete the redirects this drive added", `${created.length}`);
    }
  } finally {
    log.write();
    await browser.close();
  }

  if (failures.length > 0) {
    throw new Error(`seo failed: ${failures.join("; ")}`);
  }
};

/** Both front ends: the seeded pages a visitor reaches from the home page. */
const pagesSmoke =
  (paths: string[]): Drive =>
  async ({ origin, dir, repoRoot }) => {
    const log = transcript(dir);
    const browser = await openBrowser(repoRoot);
    let failed = false;

    try {
      const page = await browser.newPage({
        viewport: { height: 900, width: 1280 },
      });

      for (const pathname of paths) {
        const response = await page.goto(`${origin}${pathname}`, {
          waitUntil: "networkidle",
        });

        const heading =
          (await page
            .locator("h1")
            .first()
            .textContent({ timeout: 5000 })
            .catch(() => null)) ?? "(no h1)";

        const status = response?.status() ?? 0;

        failed ||= status !== 200;
        log.step(`Open ${pathname}`, `${status}, h1 "${heading.trim()}"`);
        await log.shot(
          page,
          pathname === "/"
            ? "home"
            : pathname.replaceAll("/", "-").replaceAll(/^-|-$/gu, "")
        );
      }
    } finally {
      log.write();
      await browser.close();
    }

    if (failed) {
      throw new Error("pages failed: see transcript.md");
    }
  };

// --- MCP gateway -------------------------------------------------------------

/** What READ_POST returns for one post. */
interface PostSummary {
  /** The post's hero image, as the media document's id. */
  hero: number | null;
  id: number;
  status: string;
  title: string;
  updatedAt: string;
}

/** The parts of the gateway's structured tool results this drive reads. */
interface StructuredContent<R = PostSummary> {
  approvalUrl?: string;
  executionId?: string;
  /** `describe_site`: what the Payload connector says can be written. */
  payload?: {
    collections?: {
      rowFields?: { path: string }[];
      slug: string;
      /** Upload collections only: whether Payload keeps versions of them. */
      upload?: { versions?: boolean };
    }[];
    globals?: { slug: string }[];
  };
  /** What the script returned. */
  result?: R | null;
  status?: string;
}

/** The parts of an MCP JSON-RPC result this drive reads. */
interface RpcResult<R = PostSummary> {
  content?: { text?: string; type: string }[];
  structuredContent?: StructuredContent<R>;
  tools?: { name: string }[];
}

/** The arguments of the gateway tools this drive calls. */
type ToolArguments =
  | { code: string }
  | { executionId: string }
  | Record<string, never>;

interface ToolCall {
  arguments: ToolArguments;
  name: string;
}

interface ToolResult<R = PostSummary> {
  structuredContent: StructuredContent<R>;
  text: string;
}

/**
 * One MCP request to the local gateway, as a client that is not a browser
 * sends it: JSON-RPC over Streamable HTTP, answered as JSON or as one event.
 */
const mcpRequest = async <R = PostSummary>(
  origin: string,
  token: string | null,
  method: "tools/call" | "tools/list",
  params?: ToolCall
): Promise<{ result?: RpcResult<R>; status: number }> => {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });

  if (token) {
    headers.set("cf-access-jwt-assertion", token);
  }

  const response = await fetch(`${origin}/mcp`, {
    body: JSON.stringify({
      id: 1,
      jsonrpc: "2.0",
      method,
      params: params ?? {},
    }),
    headers,
    method: "POST",
    signal: AbortSignal.timeout(180_000),
  });

  const body = await response.text();

  const json = body.startsWith("{")
    ? body
    : (body
        .split("\n")
        .findLast((line) => line.startsWith("data: "))
        ?.slice(6) ?? "");

  try {
    const parsed: { result?: RpcResult<R> } = JSON.parse(json);

    return { result: parsed.result, status: response.status };
  } catch {
    return { status: response.status };
  }
};

const callTool = async <R = PostSummary>(
  origin: string,
  token: string,
  name: string,
  args: ToolArguments
): Promise<ToolResult<R>> => {
  const { result, status } = await mcpRequest<R>(origin, token, "tools/call", {
    arguments: args,
    name,
  });

  if (!result) {
    throw new Error(`${name} answered ${status} with no result`);
  }

  return {
    structuredContent: result.structuredContent ?? {},
    text: (result.content ?? []).map((block) => block.text ?? "").join("\n"),
  };
};

/**
 * Runs one script through the gateway's `execute` tool. `R` is the shape of
 * what the script returns.
 */
const execute = <R = PostSummary>(
  origin: string,
  token: string,
  code: string
) => callTool<R>(origin, token, "execute", { code });

// A findDocuments answer is a heading and one fenced JSON block, holding one
// document or a list of them.
const READ_POST = (where: string) => `async () => {
  const found = await payload.call({
    tool: "findDocuments",
    arguments: { slug: "posts", draft: true, depth: 0, limit: 1, ${where} },
  });
  const block = /\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/.exec(found.text);
  const doc = [].concat(JSON.parse(block ? block[1] : "null"))[0];
  return doc ? { id: doc.id, title: doc.title, updatedAt: doc.updatedAt, status: doc._status, hero: doc.hero ?? null } : null;
}`;

const MARKER = / \(verify-[0-9a-f]{8}\)$/u;

/** The visible text of a gateway page, on one line. */
const mainText = async (page: Page): Promise<string> => {
  const text = await page.locator("main").textContent();

  return (text ?? "").replaceAll(/\s+/gu, " ").trim();
};

/**
 * The first published post by title, as an anonymous visitor's API read
 * returns it. Every run edits this one post, so runs don't use the seed up.
 */
const firstPublishedPost = async (
  payloadOrigin: string
): Promise<{ id: number; title: string } | undefined> => {
  const response = await fetch(
    `${payloadOrigin}/api/posts?depth=0&limit=1&sort=title`
  );

  const found: { docs?: { id: number; title: string }[] } =
    await response.json();

  return found.docs?.[0];
};

/** A post's title as an anonymous visitor's API read returns it. */
const publishedTitle = async (
  payloadOrigin: string,
  id: number
): Promise<string | undefined> => {
  const response = await fetch(`${payloadOrigin}/api/posts/${id}?depth=0`);
  const post: { title?: string } = await response.json();

  return post.title;
};

/**
 * Signs in to the local Payload admin and returns the editor's email. The
 * editor is the first local admin, created here on a fresh database the way
 * apply-form does, or signed in with "Continue as".
 */
/** A page signed in to the local Payload admin as its one local admin. */
const openLocalAdmin = async (
  browser: Browser,
  payloadOrigin: string
): Promise<Page> => {
  const admin = await browser.newPage({
    viewport: { height: 900, width: 1280 },
  });

  await admin.goto(`${payloadOrigin}/admin`, { waitUntil: "networkidle" });

  const continueAs = admin.getByRole("button", { name: /^Continue as /u });

  if (await admin.locator("#field-confirm-password").isVisible()) {
    const password = randomUUID();

    await admin.fill("#field-email", "verify@example.test");
    await admin.fill("#field-password", password);
    await admin.fill("#field-confirm-password", password);
    await admin.click("button[type=submit]");
    await admin.waitForURL(
      (url) => !url.pathname.includes("create-first-user")
    );
  } else if (await continueAs.isVisible()) {
    await continueAs.click();
    await admin.waitForLoadState("networkidle");
  }

  return admin;
};

const adminEmail = async (
  admin: Page,
  payloadOrigin: string
): Promise<string> => {
  const response = await admin.request.get(`${payloadOrigin}/api/users/me`);
  const me: { user?: { email?: string } } = await response.json();

  if (!me.user?.email) {
    throw new Error("Could not sign in to the local Payload admin.");
  }

  return me.user.email;
};

const localAdminEmail = async (
  browser: Browser,
  payloadOrigin: string
): Promise<string> => {
  const admin = await openLocalAdmin(browser, payloadOrigin);

  try {
    return await adminEmail(admin, payloadOrigin);
  } finally {
    await admin.close();
  }
};

/** The script an agent sends to retitle one post as a draft. */
const retitleScript = (options: {
  expected: string;
  hero: number | null;
  id: number;
  marker: string;
  title: string;
}) => `async () => payload.apply({
  intent: "Retitle a post for launch-verify run ${options.marker}",
  operations: [{
    kind: "update_draft",
    collection: "posts",
    id: ${options.id},
    fields: ${JSON.stringify(
      // The hero is sent as it is, so the preview has an upload to name.
      options.hero === null
        ? { title: options.title }
        : { hero: options.hero, title: options.title }
    )},
    expected_updated_at: ${JSON.stringify(options.expected)},
  }],
})`;

/** What `describe_site` says can be written in Payload, by slug. */
const describedPayload = async (
  origin: string,
  token: string
): Promise<{ globals: string[]; withRows: string[] }> => {
  const described = await callTool(origin, token, "describe_site", {});
  const site = described.structuredContent.payload;

  return {
    globals: (site?.globals ?? []).map((global) => global.slug),
    withRows: (site?.collections ?? [])
      .filter((collection) => (collection.rowFields ?? []).length > 0)
      .map((collection) => collection.slug),
  };
};

/**
 * Whether an approval page names a post's hero by its file, such as
 * "harvest.jpg (media 5)", instead of the bare id Payload stores. Undefined
 * for a post with no hero.
 */
const namesHero = (preview: string, hero: number | null): boolean | undefined =>
  hero === null
    ? undefined
    : new RegExp(`\\S+\\.\\w+ \\(media ${hero}\\)`, "u").test(preview);

/** What a run's receipt, as JSON text, says about the approved write. */
const receiptFacts = (receipt: string) => ({
  succeeded:
    receipt.includes('"status":"succeeded"') &&
    receipt.includes('"status":"changed"'),
  titleChanged: receipt.includes('"changed_paths":["title"]'),
  versioned:
    receipt.includes('"updated_at":"') && receipt.includes('"version_id":"'),
});

/**
 * MCP gateway: an editor's agent reads a post through the gateway, asks to
 * retitle it, a stale request is refused, the editor approves the real one on
 * the approval page, and Payload holds the change as a draft while the
 * published post stays as it was.
 */
const mcpPayloadDraft: Drive = async ({
  origin,
  dir,
  repoRoot,
  peers,
  signIn,
}) => {
  const payloadOrigin = peers.payload;

  if (!payloadOrigin) {
    throw new Error("No owned payload server; launch mcp first.");
  }

  const marker = `verify-${randomUUID().slice(0, 8)}`;
  const log = transcript(dir);
  const browser = await openBrowser(repoRoot);
  const failures: string[] = [];

  const expect = (pass: boolean, what: string) => {
    if (!pass) {
      failures.push(what);
    }
  };

  try {
    const email = await localAdminEmail(browser, payloadOrigin);
    const token = signIn(email);

    log.step(
      "Sign in to the gateway as the local admin",
      `${email}, with a JWT signed by the local Access stand-in`
    );

    const anonymous = await mcpRequest(origin, null, "tools/list");

    expect(
      [401, 403].includes(anonymous.status),
      "a request with no sign-in was not refused"
    );
    log.step("POST /mcp tools/list with no sign-in", `${anonymous.status}`);

    // Payload's MCP plugin can run its own OAuth server, which would let an
    // MCP client sign in to Payload without Access. Launch turns it off.
    const discovery = await fetch(
      `${payloadOrigin}/api/mcp/oauth/.well-known/openid-configuration`
    );

    const registration = await fetch(
      `${payloadOrigin}/api/mcp/oauth/register`,
      {
        body: JSON.stringify({
          client_name: "launch-verify",
          redirect_uris: ["http://localhost/callback"],
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }
    );

    expect(
      discovery.status === 404 && registration.status === 404,
      "Payload serves its own OAuth sign-in for MCP clients"
    );
    log.step(
      "Ask Payload for its own MCP OAuth sign-in: discovery, then client registration",
      `${discovery.status}, ${registration.status}`
    );

    const listed = await mcpRequest(origin, token, "tools/list");
    const tools = (listed.result?.tools ?? []).map((tool) => tool.name);

    expect(tools.includes("execute"), "the gateway lists no execute tool");
    log.step("POST /mcp tools/list, signed in", tools.join(", "));

    const site = await describedPayload(origin, token);

    expect(
      site.withRows.length > 0 && site.globals.length > 0,
      "describe_site lists no rows or no globals for Payload"
    );
    log.step(
      "describe_site: what Payload says can be written",
      `collections with arrays or blocks: ${site.withRows.join(", ")}; globals: ${site.globals.join(", ")}`
    );

    const live = await firstPublishedPost(payloadOrigin);

    if (!live) {
      throw new Error("No published post to edit: seed Payload first.");
    }

    const read = await execute(
      origin,
      token,
      READ_POST(`where: { id: { equals: ${live.id} } }`)
    );

    const post = read.structuredContent.result;

    if (!post) {
      throw new Error(
        `The gateway could not read posts/${live.id}: ${read.text.slice(0, 200)}`
      );
    }

    const before = live.title;
    const title = `${post.title.replace(MARKER, "")} (${marker})`;
    const request = { hero: post.hero, id: post.id, marker, title };

    log.step(
      "execute: read a published post's newest draft through payload.call",
      `posts/${post.id} "${post.title}" (${post.status}), updated ${post.updatedAt}; published as "${before}"`
    );

    const paused = await execute(
      origin,
      token,
      retitleScript({ ...request, expected: post.updatedAt })
    );

    const { approvalUrl = "", executionId = "" } = paused.structuredContent;

    expect(
      paused.structuredContent.status === "paused",
      `payload.apply did not pause for approval: ${paused.text.slice(0, 200)}`
    );
    expect(
      approvalUrl.startsWith(`${origin}/mcp/approvals/`),
      `the approval link is not on the local gateway: ${approvalUrl}`
    );
    log.step(
      "execute: payload.apply with the current updatedAt",
      `${paused.structuredContent.status}; ${paused.text.slice(0, 160)}`
    );

    if (failures.length > 0) {
      throw new Error("the run never reached approval");
    }

    // The approver is the same editor, in a browser that Access has signed
    // in: locally, the stand-in's JWT on every request.
    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
      viewport: { height: 900, width: 1280 },
    });

    const page = await context.newPage();
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    // A request built on an old read pauses like any other; its preview is
    // where the gateway finds the document has moved on and offers no
    // Approve button.
    const stale = await execute(
      origin,
      token,
      retitleScript({ ...request, expected: "2000-01-01T00:00:00.000Z" })
    );

    const staleUrl = stale.structuredContent.approvalUrl ?? "";

    expect(
      staleUrl.startsWith(`${origin}/mcp/approvals/`),
      `the stale request has no local approval link: ${stale.text.slice(0, 200)}`
    );

    if (failures.length > 0) {
      throw new Error("the stale request never reached its approval page");
    }

    await page.goto(staleUrl, { waitUntil: "networkidle" });

    const refusal = await mainText(page);

    const offered = await page
      .getByRole("button", { name: "Approve" })
      .isVisible();

    expect(!offered, "a stale expected_updated_at was offered for approval");
    expect(
      refusal.includes("stale_expected_updated_at"),
      "the stale request's page does not say why it was refused"
    );
    log.step(
      "Open the approval page of a request with a stale expected_updated_at",
      `Approve offered: ${offered}; page says: ${refusal.slice(0, 200)}`
    );
    await log.shot(page, "stale-refused");

    await page.goto(approvalUrl, { waitUntil: "networkidle" });

    const preview = await mainText(page);

    expect(
      preview.includes(marker),
      "the approval page does not show the new title"
    );

    const heroNamed = namesHero(preview, post.hero);

    expect(
      heroNamed !== false,
      "the approval page shows the hero as a bare id"
    );
    log.step(
      "Open the approval page",
      `shows the new title: ${preview.includes(marker)}; shows the old title: ${preview.includes(post.title)}; names the hero's file: ${heroNamed ?? "no hero"}`
    );
    await log.shot(page, "approval");

    await page.getByRole("button", { name: "Approve" }).click();
    await page.waitForLoadState("networkidle");

    const outcome = await mainText(page);

    log.step("Click Approve", outcome.slice(0, 200));
    await log.shot(page, "approved");

    const run = await callTool(origin, token, "get_run", { executionId });
    const receipt = JSON.stringify(run.structuredContent);

    writeFileSync(
      path.join(dir, "run.json"),
      `${JSON.stringify(run.structuredContent, null, 2)}\n`
    );
    const landed = receiptFacts(receipt);

    expect(landed.succeeded, "get_run reports no successful change");
    expect(
      landed.versioned,
      "the receipt does not say when the post was updated or which version was made"
    );
    log.step(
      "get_run for the approved run",
      `succeeded: ${landed.succeeded}; title changed: ${landed.titleChanged}; names the new version: ${landed.versioned} (run.json)`
    );

    const after = await execute(
      origin,
      token,
      READ_POST(`where: { id: { equals: ${post.id} } }`)
    );

    const draft = after.structuredContent.result;
    const published = await publishedTitle(payloadOrigin, post.id);

    expect(draft?.title === title, "the draft does not hold the new title");
    expect(
      published === before,
      "the published post changed; the edit should be a draft"
    );
    log.step(
      "Read the post again: the newest draft, then the public API",
      `draft "${draft?.title}" (${draft?.status}); published "${published}"`
    );

    log.step(
      "Browser console errors on the approval page",
      errors.length ? errors.join(" | ") : "none"
    );
    await context.close();
  } finally {
    log.write();
    await browser.close();
  }

  if (failures.length > 0) {
    throw new Error(`payload-draft failed: ${failures.join("; ")}`);
  }
};

/** A picture no earlier run made: a small card with the run's marker on it. */
const drawPicture = async (
  browser: Browser,
  marker: string,
  color: string
): Promise<Buffer> => {
  const page = await browser.newPage({ viewport: { height: 240, width: 360 } });

  await page.setContent(
    `<body style="margin:0;display:grid;place-items:center;height:100vh;background:${color};color:#fff;font:600 22px system-ui">${marker}</body>`
  );

  const picture = await page.screenshot({ type: "png" });

  await page.close();

  return picture;
};

const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** Where `payload.stageUpload` is told to take a file from. */
type StageSource =
  | { base64: string; filename: string; mimeType: string }
  | { url: string };

/** The script an agent sends to stage one picture and ask for it to be saved. */
const uploadScript = (options: {
  filename: string;
  marker: string;
  operation: object;
  picture: Buffer;
}) => `async () => {
  const file = await payload.stageUpload({
    collection: "media",
    source: {
      base64: ${JSON.stringify(options.picture.toString("base64"))},
      filename: ${JSON.stringify(options.filename)},
      mimeType: "image/png",
    },
  });
  return payload.apply({
    intent: "Add a picture for launch-verify run ${options.marker}",
    operations: [{ ...${JSON.stringify(options.operation)}, upload_ref: file.upload_ref }],
  });
}`;

/** The script an agent sends to stage a file that is refused before any approval. */
const refusedStageScript = (source: StageSource) =>
  `async () => payload.stageUpload({ collection: "media", source: ${JSON.stringify(source)} })`;

const SVG_FILE =
  '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>';

/** Whether `describe_site` says Payload keeps versions of media documents. */
const mediaKeepsVersions = async (
  origin: string,
  token: string
): Promise<boolean> => {
  const described = await callTool(origin, token, "describe_site", {});

  const media = (described.structuredContent.payload?.collections ?? []).find(
    (collection) => collection.slug === "media"
  );

  return media?.upload?.versions === true;
};

/** What Payload's public API says about one media file. */
interface MediaDocument {
  alt?: string;
  filename?: string;
  updatedAt?: string;
  url?: string;
}

const readMedia = async (
  payloadOrigin: string,
  id: string
): Promise<MediaDocument> => {
  const response = await fetch(`${payloadOrigin}/api/media/${id}?depth=0`);

  return response.ok ? await response.json() : {};
};

/** The SHA-256 of the file Payload serves at a media document's URL. */
const servedSha256 = async (
  payloadOrigin: string,
  url: string | undefined
): Promise<string> => {
  if (!url) {
    return "no url";
  }

  const response = await fetch(
    new URL(new URL(url, payloadOrigin).pathname, payloadOrigin)
  );

  return response.ok
    ? sha256(new Uint8Array(await response.arrayBuffer()))
    : `HTTP ${response.status}`;
};

/** How many thumbnails an approval page draws, and its visible text. */
const approvalPreview = async (page: Page) => ({
  text: await mainText(page),
  thumbnails: await page
    .locator('img.thumb[src^="data:image/webp;base64,"]')
    .count(),
});

/** What a run's receipt, as JSON text, says about an approved upload. */
const uploadFacts = (receipt: string) => ({
  id: /"details":\{[^}]*"id":"(?<id>\d+)"/u.exec(receipt)?.groups?.id ?? "",
  succeeded:
    receipt.includes('"status":"succeeded"') &&
    receipt.includes('"changed_paths":["file"'),
  versioned:
    receipt.includes('"updated_at":"') && receipt.includes('"version_id":"'),
});

/**
 * MCP gateway: an editor's agent stages a picture, a file the gateway does
 * not take is refused before anyone is asked, the editor approves the upload
 * with its thumbnail in front of them, Payload stores and serves the same
 * bytes, and then the file is replaced the same way.
 */
const mcpPayloadUpload: Drive = async ({
  origin,
  dir,
  repoRoot,
  peers,
  signIn,
}) => {
  const payloadOrigin = peers.payload;

  if (!payloadOrigin) {
    throw new Error("No owned payload server; launch mcp first.");
  }

  const marker = `verify-${randomUUID().slice(0, 8)}`;
  const log = transcript(dir);
  const browser = await openBrowser(repoRoot);
  const failures: string[] = [];

  const expect = (pass: boolean, what: string) => {
    if (!pass) {
      failures.push(what);
    }
  };

  try {
    const email = await localAdminEmail(browser, payloadOrigin);
    const token = signIn(email);

    log.step(
      "Sign in to the gateway as the local admin",
      `${email}, with a JWT signed by the local Access stand-in`
    );

    const svg = await execute(
      origin,
      token,
      refusedStageScript({
        base64: Buffer.from(SVG_FILE).toString("base64"),
        filename: "logo.png",
        mimeType: "image/png",
      })
    );

    const byUrl = await execute(
      origin,
      token,
      refusedStageScript({ url: "https://example.com/picture.png" })
    );

    expect(
      svg.text.includes("SVG files are not accepted"),
      `an SVG named as a PNG was not refused: ${svg.text.slice(0, 200)}`
    );
    expect(
      byUrl.structuredContent.status === "error",
      `a URL the collection does not allow was not refused: ${byUrl.text.slice(0, 200)}`
    );
    log.step(
      "execute: payload.stageUpload with an SVG declared as a PNG, then with a URL the collection does not allow",
      `${svg.text.slice(0, 120)} | ${byUrl.text.slice(0, 140)}`
    );

    const first = await drawPicture(browser, marker, "#2f6f4f");
    const filename = `${marker}.png`;

    const paused = await execute(
      origin,
      token,
      uploadScript({
        filename,
        marker,
        operation: {
          collection: "media",
          fields: { alt: `Launch verify picture ${marker}` },
          kind: "upload_media",
        },
        picture: first,
      })
    );

    const { approvalUrl = "", executionId = "" } = paused.structuredContent;

    expect(
      paused.structuredContent.status === "paused" &&
        approvalUrl.startsWith(`${origin}/mcp/approvals/`),
      `the upload did not pause for approval: ${paused.text.slice(0, 200)}`
    );
    log.step(
      `execute: payload.stageUpload with a ${first.byteLength}-byte PNG, then payload.apply upload_media`,
      `${paused.structuredContent.status}; ${paused.text.slice(0, 160)}`
    );

    if (failures.length > 0) {
      throw new Error("the upload never reached approval");
    }

    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
      viewport: { height: 900, width: 1280 },
    });

    const page = await context.newPage();
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    await page.goto(approvalUrl, { waitUntil: "networkidle" });

    const preview = await approvalPreview(page);

    expect(
      preview.text.includes(filename) && preview.text.includes("image/png"),
      "the approval page does not name the file and its type"
    );
    expect(
      preview.text.includes(sha256(first).slice(0, 12)),
      "the approval page does not show the hash of the staged file"
    );
    expect(preview.thumbnails === 1, "the approval page shows no thumbnail");
    log.step(
      "Open the approval page",
      `names ${filename}: ${preview.text.includes(filename)}; shows the file's hash: ${preview.text.includes(sha256(first).slice(0, 12))}; thumbnails drawn: ${preview.thumbnails}`
    );
    await log.shot(page, "upload-approval");

    await page.getByRole("button", { name: "Approve" }).click();
    await page.waitForLoadState("networkidle");

    const outcome = await mainText(page);

    log.step("Click Approve", outcome.slice(0, 200));
    await log.shot(page, "upload-approved");

    const run = await callTool(origin, token, "get_run", { executionId });
    const uploaded = uploadFacts(JSON.stringify(run.structuredContent));

    writeFileSync(
      path.join(dir, "run.json"),
      `${JSON.stringify(run.structuredContent, null, 2)}\n`
    );

    expect(
      uploaded.succeeded && uploaded.id !== "",
      "get_run reports no uploaded file"
    );

    // A collection that keeps no versions has none to name.
    const versions = await mediaKeepsVersions(origin, token);

    expect(
      uploaded.versioned || !versions,
      "the upload's receipt does not name the version Payload made"
    );

    if (failures.length > 0) {
      throw new Error("the upload did not land");
    }

    const media = await readMedia(payloadOrigin, uploaded.id);
    const served = await servedSha256(payloadOrigin, media.url);

    expect(
      served === sha256(first),
      `Payload does not serve the bytes that were approved (${served})`
    );
    expect(
      media.alt === `Launch verify picture ${marker}`,
      "the new media document does not hold its alt text"
    );
    log.step(
      "get_run, then read the new file from Payload's public API",
      `media/${uploaded.id} "${media.filename}", alt "${media.alt}"; media keeps versions: ${versions}; names its version: ${uploaded.versioned}; served bytes match the approved file: ${served === sha256(first)} (run.json)`
    );

    const second = await drawPicture(browser, `${marker} v2`, "#7a3e9d");

    const replacing = await execute(
      origin,
      token,
      uploadScript({
        filename: `${marker}-v2.png`,
        marker,
        operation: {
          collection: "media",
          expected_updated_at: media.updatedAt,
          id: Number(uploaded.id),
          kind: "replace_media_file",
        },
        picture: second,
      })
    );

    const replaceUrl = replacing.structuredContent.approvalUrl ?? "";

    expect(
      replaceUrl.startsWith(`${origin}/mcp/approvals/`),
      `the replacement did not pause for approval: ${replacing.text.slice(0, 200)}`
    );

    if (failures.length > 0) {
      throw new Error("the replacement never reached approval");
    }

    await page.goto(replaceUrl, { waitUntil: "networkidle" });

    const comparison = await approvalPreview(page);

    expect(
      comparison.thumbnails === 2,
      `the replacement's approval page shows ${comparison.thumbnails} thumbnails, not the old file and the new one`
    );
    expect(
      comparison.text.includes("Heads up") &&
        comparison.text.includes("at once everywhere it is used"),
      "the replacement's approval page does not warn that it shows at once"
    );
    expect(
      comparison.text.includes(sha256(first).slice(0, 12)) &&
        comparison.text.includes(sha256(second).slice(0, 12)),
      "the replacement's approval page does not show both files' hashes"
    );
    log.step(
      "execute: stage a second picture and payload.apply replace_media_file, then open its approval page",
      `thumbnails drawn: ${comparison.thumbnails}; warns it shows at once: ${comparison.text.includes("Heads up")}; shows both hashes: ${comparison.text.includes(sha256(first).slice(0, 12)) && comparison.text.includes(sha256(second).slice(0, 12))}`
    );
    await log.shot(page, "replace-approval");

    await page.getByRole("button", { name: "Approve" }).click();
    await page.waitForLoadState("networkidle");

    const replacedOutcome = await mainText(page);

    log.step("Click Approve", replacedOutcome.slice(0, 200));
    await log.shot(page, "replace-approved");

    const replaced = await readMedia(payloadOrigin, uploaded.id);
    const servedNow = await servedSha256(payloadOrigin, replaced.url);

    expect(
      servedNow === sha256(second),
      `Payload does not serve the replacement (${servedNow})`
    );
    expect(
      replaced.alt === media.alt,
      "replacing the file changed the document's alt text"
    );
    log.step(
      "Read the file again from Payload's public API",
      `media/${uploaded.id} "${replaced.filename}"; served bytes match the replacement: ${servedNow === sha256(second)}; alt kept: ${replaced.alt === media.alt}`
    );

    log.step(
      "Browser console errors on the approval pages",
      errors.length ? errors.join(" | ") : "none"
    );
    await context.close();
  } finally {
    log.write();
    await browser.close();
  }

  if (failures.length > 0) {
    throw new Error(`payload-upload failed: ${failures.join("; ")}`);
  }
};

/** What READ_HOME returns: the home page's newest draft, as rows. */
interface PageSummary {
  /** The first content section's body as Markdown, and that section's id. */
  body: { markdown: string; rowId: string } | null;
  /** The first card grid with more than one card. */
  grid: { cards: { id: string; title: string }[]; rowId: string } | null;
  id: number;
  /** The whole `layout` field, as JSON text. */
  layout: string;
  updatedAt: string;
}

// The home page's newest draft through the gateway: its sections, and one
// section's rich text as Markdown, converted by Payload with that nested
// field's own editor.
const READ_HOME = `async () => {
  const found = await payload.call({
    tool: "findDocuments",
    arguments: { slug: "pages", draft: true, depth: 0, limit: 1, where: { slug: { equals: "home" } } },
  });
  const block = /\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/.exec(found.text);
  const doc = [].concat(JSON.parse(block ? block[1] : "null"))[0];
  if (!doc) return null;
  const grid = doc.layout.find((row) => row.blockType === "cardGrid" && row.cards.length > 1);
  const content = doc.layout.find((row) => row.blockType === "content" && row.body);
  const body = content && await payload.call({
    tool: "richTextToMarkdown",
    arguments: { slug: "pages", field: "body", path: ["layout", "content", "body"], value: content.body },
  });
  return {
    body: body && body.structured ? { markdown: body.structured.markdown, rowId: content.id } : null,
    grid: grid ? { cards: grid.cards.map((card) => ({ id: card.id, title: card.title })), rowId: grid.id } : null,
    id: doc.id,
    layout: JSON.stringify(doc.layout),
    updatedAt: doc.updatedAt,
  };
}`;

/** The home page's newest draft, read through the gateway. */
const readHome = async (
  origin: string,
  token: string
): Promise<PageSummary | null> => {
  const read = await execute<PageSummary>(origin, token, READ_HOME);

  return read.structuredContent.result ?? null;
};

/** One row of an array or blocks field, as Payload's REST API returns it. */
interface StoredRow {
  cards?: StoredRow[];
  id: string;
  title?: string;
}

const parseRows = (layout: string): StoredRow[] => JSON.parse(layout);

/** The home page's sections as an anonymous visitor's API read returns them. */
const publishedLayout = async (
  payloadOrigin: string,
  id: number
): Promise<StoredRow[]> => {
  const response = await fetch(`${payloadOrigin}/api/pages/${id}?depth=0`);
  const page: { layout?: StoredRow[] } = await response.json();

  return page.layout ?? [];
};

const cardTitle = (
  layout: StoredRow[],
  gridId: string,
  cardId: string
): string | undefined =>
  layout
    .find((row) => row.id === gridId)
    ?.cards?.find((card) => card.id === cardId)?.title;

/** The row changes this drive asks for. */
type RowChangeRequest =
  | {
      after_id: string | null;
      field: string;
      op: "insert";
      row: { title: string };
    }
  | { field: string; op: "remove"; row_id: string }
  | { markdown: string; op: "set_markdown"; path: string }
  | { op: "set"; path: string; value: string };

/** The script an agent sends to change rows of the home page's sections. */
const rowsScript = (options: {
  changes: RowChangeRequest[];
  expected: string;
  id: number;
  marker: string;
}) => `async () => payload.apply({
  intent: "Change rows of the home page for launch-verify run ${options.marker}",
  operations: [{
    kind: "patch_rows",
    collection: "pages",
    id: ${options.id},
    expected_updated_at: ${JSON.stringify(options.expected)},
    changes: ${JSON.stringify(options.changes)},
  }],
})`;

/** The id Payload gave a row a run put in, from that run's receipt. */
const insertedRowId = (receipt: string): string =>
  /"inserted_row_ids":"(?<id>[A-Za-z0-9_-]+)"/u.exec(receipt)?.groups?.id ?? "";

/** A signed-in caller of the local gateway. */
interface Session {
  origin: string;
  token: string;
}

/** What the rows drive carries from one step to the next. */
interface RowsRun extends Session {
  /** The card that is retitled. */
  card: { id: string; title: string };
  /** The path of the grid's `cards` field. */
  cardsField: string;
  dir: string;
  expect: (pass: boolean, what: string) => void;
  grid: { cards: { id: string; title: string }[]; rowId: string };
  log: ReturnType<typeof transcript>;
  marker: string;
  pageId: number;
  /** The card's new title. */
  title: string;
  /** The path of the card's `title` field. */
  titlePath: string;
}

/** A row request that paused: its run, and where a person approves it. */
interface RowsRequest {
  executionId: string;
  url: string;
}

/** Sends row changes for the home page and expects them to pause. */
const requestRows = async (
  run: RowsRun,
  expected: string,
  changes: RowChangeRequest[]
): Promise<RowsRequest> => {
  const result = await execute(
    run.origin,
    run.token,
    rowsScript({ changes, expected, id: run.pageId, marker: run.marker })
  );

  const url = result.structuredContent.approvalUrl ?? "";

  if (!url.startsWith(`${run.origin}/mcp/approvals/`)) {
    throw new Error(
      `the row changes did not pause for approval: ${result.text.slice(0, 200)}`
    );
  }

  return { executionId: result.structuredContent.executionId ?? "", url };
};

/** Clicks Approve and reads what the page says once the write is over. */
const approve = async (page: Page): Promise<string> => {
  await page.getByRole("button", { name: "Approve" }).click();
  await page.waitForLoadState("networkidle");

  return mainText(page);
};

/** A run's record, as `get_run` reports it. */
const runRecord = async (run: Session, executionId: string) => {
  const result = await callTool(run.origin, run.token, "get_run", {
    executionId,
  });

  return result.structuredContent;
};

const retitleOf = (run: RowsRun): RowChangeRequest => ({
  op: "set",
  path: run.titlePath,
  value: run.title,
});

/**
 * Asks to retitle one card, opens the approval page and leaves it open, the
 * way an approver might leave a tab while someone else edits the page.
 */
const previewRetitle = async (
  run: RowsRun,
  page: Page,
  expected: string
): Promise<void> => {
  const request = await requestRows(run, expected, [retitleOf(run)]);

  await page.goto(request.url, { waitUntil: "networkidle" });

  const preview = await mainText(page);

  const titles = [run.title, run.card.title].every((text) =>
    preview.includes(text)
  );

  const labelled = ["Card grid (row", run.titlePath].every((text) =>
    preview.includes(text)
  );

  run.expect(
    titles,
    "the approval page does not show the card's title before and after"
  );
  run.expect(
    labelled,
    "the approval page does not say which row the change is in"
  );
  run.log.step(
    "execute: payload.apply patch_rows retitling one card, then open its approval page and leave it open",
    `shows the old and new title: ${titles}; labels the row: ${labelled}`
  );
  await run.log.shot(page, "retitle-approval");
};

/**
 * A second request, built on the same read, puts a card in the grid and is
 * approved. Gives back the id Payload made for the new row.
 */
const approveInsert = async (
  run: RowsRun,
  page: Page,
  expected: string
): Promise<string> => {
  const newTitle = `Launch verify card ${run.marker}`;

  const request = await requestRows(run, expected, [
    {
      after_id: run.grid.cards.at(-1)?.id ?? null,
      field: run.cardsField,
      op: "insert",
      row: { title: newTitle },
    },
  ]);

  await page.goto(request.url, { waitUntil: "networkidle" });

  const preview = await mainText(page);
  const shown = ["(new row)", newTitle].every((text) => preview.includes(text));

  run.expect(shown, "the insert's approval page does not show the new row");
  await run.log.shot(page, "insert-approval");
  await approve(page);

  const record = await runRecord(run, request.executionId);
  const insertedId = insertedRowId(JSON.stringify(record));

  run.log.step(
    "A second request puts a card in the same grid; approve it in another tab",
    `shows the new row: ${shown}; the receipt names the row Payload made: ${insertedId || "no"}`
  );

  if (!insertedId) {
    throw new Error("the insert's receipt does not name the new row");
  }

  return insertedId;
};

/** The home page after the insert: what the last request is built on. */
interface CurrentHome {
  body: { markdown: string; rowId: string };
  updatedAt: string;
}

/**
 * Approves the first request, whose preview was drawn before the insert. It
 * has to be refused, with the card left as it was.
 */
const refuseOutdated = async (
  run: RowsRun,
  page: Page
): Promise<CurrentHome> => {
  const refused = await approve(page);
  const now = await readHome(run.origin, run.token);

  if (!now?.body) {
    throw new Error("the home page could not be read after the insert");
  }

  run.expect(
    refused.includes("modified_since_preflight"),
    `approving a preview the page has moved on from was not refused: ${refused.slice(0, 200)}`
  );
  run.expect(
    cardTitle(parseRows(now.layout), run.grid.rowId, run.card.id) ===
      run.card.title,
    "the refused request changed the card anyway"
  );
  run.log.step(
    "Go back to the first tab and click Approve on its now outdated preview",
    `${refused.slice(refused.indexOf("Result:")).slice(0, 44)}; says modified_since_preflight: ${refused.includes("modified_since_preflight")}`
  );
  await run.log.shot(page, "outdated-refused");

  return { body: now.body, updatedAt: now.updatedAt };
};

/**
 * The request that lands, built on the page as it is now: retitle the card,
 * take the new card out again, and send one section's body back unchanged.
 */
const approveRows = async (
  run: RowsRun,
  page: Page,
  options: { current: CurrentHome; insertedId: string }
): Promise<void> => {
  const bodyPath = `layout[id=${options.current.body.rowId}].body`;
  const removedPath = `${run.cardsField}[id=${options.insertedId}]`;

  const request = await requestRows(run, options.current.updatedAt, [
    retitleOf(run),
    { field: run.cardsField, op: "remove", row_id: options.insertedId },
    {
      markdown: options.current.body.markdown,
      op: "set_markdown",
      path: bodyPath,
    },
  ]);

  await page.goto(request.url, { waitUntil: "networkidle" });

  const preview = await mainText(page);

  run.expect(
    ["(removed)", run.title].every((text) => preview.includes(text)),
    "the last approval page does not show the retitle and the removed row"
  );
  await run.log.shot(page, "rows-approval");

  const outcome = await approve(page);

  await run.log.shot(page, "rows-approved");

  const record = await runRecord(run, request.executionId);
  const receipt = JSON.stringify(record);

  writeFileSync(
    path.join(run.dir, "run.json"),
    `${JSON.stringify(record, null, 2)}\n`
  );

  const listed = [
    '"status":"succeeded"',
    JSON.stringify(run.titlePath),
    removedPath,
  ].every((text) => receipt.includes(text));

  run.expect(
    listed,
    "get_run does not report the retitle and the removal as changed"
  );
  run.expect(
    !receipt.includes(bodyPath),
    "the unchanged Markdown was reported as a change"
  );
  run.log.step(
    "execute: retitle the card, remove the new card and resend one body's Markdown unchanged; approve it",
    `${outcome.slice(outcome.indexOf("Result:")).slice(0, 60)}; receipt lists the retitle and the removal: ${listed}; lists the unchanged body: ${receipt.includes(bodyPath)} (run.json)`
  );
};

/**
 * The end state: the draft holds the new title, every other row is as it
 * was first read, and the published page has not changed.
 */
const checkRowsLanded = async (
  run: RowsRun,
  before: { layout: string; published: string | undefined; payload: string }
): Promise<void> => {
  const final = await readHome(run.origin, run.token);
  const rows = parseRows(final?.layout ?? "[]");
  const draftTitle = cardTitle(rows, run.grid.rowId, run.card.id);

  // Every row but the retitled card, byte for byte as it was first read.
  const untouched =
    JSON.stringify(rows).replace(
      JSON.stringify(run.title),
      JSON.stringify(run.card.title)
    ) === JSON.stringify(parseRows(before.layout));

  const published = cardTitle(
    await publishedLayout(before.payload, run.pageId),
    run.grid.rowId,
    run.card.id
  );

  run.expect(
    draftTitle === run.title,
    "the draft does not hold the card's new title"
  );
  run.expect(untouched, "a row the changes did not name is not as it was");
  run.expect(
    published === before.published,
    "the published page changed; the edit should be a draft"
  );
  run.log.step(
    "Read the page again: the newest draft, then the public API",
    `draft card "${draftTitle}"; every other row unchanged: ${untouched}; published card "${published}"`
  );
};

/**
 * MCP gateway: an editor's agent changes single rows of the home page's
 * sections. One card is retitled without resending the page, a row is put in
 * and taken out again, a request the page has moved on from is refused at
 * approval, and the published page stays as it was.
 */
const mcpPayloadRows: Drive = async ({
  origin,
  dir,
  repoRoot,
  peers,
  signIn,
}) => {
  const payloadOrigin = peers.payload;

  if (!payloadOrigin) {
    throw new Error("No owned payload server; launch mcp first.");
  }

  const marker = `verify-${randomUUID().slice(0, 8)}`;
  const log = transcript(dir);
  const browser = await openBrowser(repoRoot);
  const failures: string[] = [];

  try {
    const email = await localAdminEmail(browser, payloadOrigin);
    const token = signIn(email);

    log.step(
      "Sign in to the gateway as the local admin",
      `${email}, with a JWT signed by the local Access stand-in`
    );

    const home = await readHome(origin, token);
    const [, card] = home?.grid?.cards ?? [];

    if (!(home?.grid && home.body && card)) {
      throw new Error(
        "The home page has no card grid and content section to change: seed Payload first."
      );
    }

    const cardsField = `layout[id=${home.grid.rowId}].cards`;

    const run: RowsRun = {
      card,
      cardsField,
      dir,
      expect: (pass, what) => {
        if (!pass) {
          failures.push(what);
        }
      },
      grid: home.grid,
      log,
      marker,
      origin,
      pageId: home.id,
      title: `${card.title.replace(MARKER, "")} (${marker})`,
      titlePath: `${cardsField}[id=${card.id}].title`,
      token,
    };

    const published = cardTitle(
      await publishedLayout(payloadOrigin, home.id),
      home.grid.rowId,
      card.id
    );

    log.step(
      "execute: read the home page's newest draft, and one section's body as Markdown",
      `pages/${home.id}, updated ${home.updatedAt}; card "${card.title}" in a grid of ${home.grid.cards.length}; published as "${published}"; body is ${home.body.markdown.length} characters of Markdown`
    );

    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
      viewport: { height: 900, width: 1280 },
    });

    const page = await context.newPage();
    const other = await context.newPage();
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    await previewRetitle(run, page, home.updatedAt);

    const insertedId = await approveInsert(run, other, home.updatedAt);
    const current = await refuseOutdated(run, page);

    await approveRows(run, page, { current, insertedId });
    await checkRowsLanded(run, {
      layout: home.layout,
      payload: payloadOrigin,
      published,
    });

    log.step(
      "Browser console errors on the approval pages",
      errors.length ? errors.join(" | ") : "none"
    );
    await context.close();
  } finally {
    log.write();
    await browser.close();
  }

  if (failures.length > 0) {
    throw new Error(`payload-rows failed: ${failures.join("; ")}`);
  }
};

/** What READ_SETTINGS returns: the site settings global. */
interface SettingsSummary {
  siteName: string;
  tagline: string | null;
  updatedAt: string;
}

// The site settings global through the gateway, read as the admin opens it:
// its newest version, whose `updatedAt` a write is checked against.
const READ_SETTINGS = `async () => {
  const found = await payload.call({
    tool: "findGlobalDraft",
    arguments: { slug: "site-settings", depth: 0 },
  });
  const doc = found.structured && found.structured.doc;
  return doc && { siteName: doc.siteName, tagline: doc.tagline ?? null, updatedAt: doc.updatedAt };
}`;

/** The site settings as an anonymous visitor's API read returns them. */
const publicSettings = async (
  payloadOrigin: string
): Promise<{ siteName?: string; tagline?: string | null }> => {
  const response = await fetch(
    `${payloadOrigin}/api/globals/site-settings?depth=0`
  );

  return await response.json();
};

/** The script an agent sends to change the site's tagline. */
const globalScript = (options: {
  expected: string;
  marker: string;
  publish: boolean;
  tagline: string;
}) => `async () => payload.apply({
  intent: "Change the site tagline for launch-verify run ${options.marker}",
  operations: [{
    kind: "update_global",
    global: "site-settings",
    expected_updated_at: ${JSON.stringify(options.expected)},
    fields: { tagline: ${JSON.stringify(options.tagline)} },${options.publish ? "\n    publish: true," : ""}
  }],
})`;

/** What a gateway drive carries from one step to the next. */
interface DriveRun extends Session {
  dir: string;
  expect: (pass: boolean, what: string) => void;
  log: ReturnType<typeof transcript>;
  marker: string;
}

/** Opens the approval page a script pauses on. */
const openApproval = async (
  run: Session,
  page: Page,
  code: string
): Promise<{ executionId: string; preview: string }> => {
  const result = await execute(run.origin, run.token, code);
  const url = result.structuredContent.approvalUrl ?? "";

  if (!url.startsWith(`${run.origin}/mcp/approvals/`)) {
    throw new Error(
      `the request has no local approval link: ${result.text.slice(0, 200)}`
    );
  }

  await page.goto(url, { waitUntil: "networkidle" });

  return {
    executionId: result.structuredContent.executionId ?? "",
    preview: await mainText(page),
  };
};

/**
 * A request Payload's state does not allow: its page says why and offers no
 * Approve button.
 */
const refusedRequest = async (
  run: DriveRun,
  page: Page,
  request: { code: string; reason: string; shot: string; what: string }
): Promise<void> => {
  const { preview } = await openApproval(run, page, request.code);

  const offered = await page
    .getByRole("button", { name: "Approve" })
    .isVisible();

  run.expect(!offered, `${request.what} was offered for approval`);
  run.expect(
    preview.includes(request.reason),
    `the page of ${request.what} does not say ${request.reason}`
  );
  run.log.step(
    `Open the approval page of ${request.what}`,
    `Approve offered: ${offered}; says ${request.reason}: ${preview.includes(request.reason)}`
  );
  await run.log.shot(page, request.shot);
};

const LOCK_REASON = "open in the Payload admin for another editor";

/** What another editor has open, as Payload's lock document names it. */
interface HeldLock {
  /** The lock document's own fields: `globalSlug`, or `document`. */
  data:
    | { document: { relationTo: string; value: number | string } }
    | { globalSlug: string };
  /** How the transcript names it, such as "the site settings". */
  named: string;
  /** How the refused request reads, such as "a change to a global". */
  what: string;
}

/**
 * Another editor has something open: Payload keeps a lock document for
 * them, as its admin does while a form is open. A change asked for meanwhile
 * is refused, and their lock is still there afterwards. Payload itself would
 * save a global, or restore a version, and remove the lock. The second
 * editor is made for this step and removed after it.
 */
const refusedWhileLocked = async (
  run: DriveRun,
  page: Page,
  options: { admin: Page; code: string; lock: HeldLock; payloadOrigin: string }
): Promise<void> => {
  const api = `${options.payloadOrigin}/api`;
  const { request } = options.admin;

  const created = await request.post(`${api}/users`, {
    data: { email: `${run.marker}@example.test`, password: randomUUID() },
  });

  const editor: { doc?: { id?: number | string } } = await created.json();
  const editorId = editor.doc?.id;

  if (editorId === undefined) {
    throw new Error(`Could not add a second editor: HTTP ${created.status()}`);
  }

  try {
    const locked = await request.post(`${api}/payload-locked-documents`, {
      data: {
        ...options.lock.data,
        user: { relationTo: "users", value: editorId },
      },
    });

    const lock: { doc?: { id?: number | string } } = await locked.json();
    const lockId = lock.doc?.id;

    if (lockId === undefined) {
      throw new Error(
        `Could not lock ${options.lock.named}: HTTP ${locked.status()}`
      );
    }

    run.log.step(
      `Lock ${options.lock.named} for a second editor, as the admin does while they have it open`,
      `lock ${lockId} held by ${run.marker}@example.test`
    );

    await refusedRequest(run, page, {
      code: options.code,
      reason: LOCK_REASON,
      shot: "locked-refused",
      what: `${options.lock.what} another editor has open`,
    });

    const held = await request.get(`${api}/payload-locked-documents/${lockId}`);

    run.expect(held.ok(), "the other editor's lock is gone after the refusal");
    run.log.step(
      "Read the other editor's lock after the refusal",
      `still held: ${held.ok()}`
    );
    await request.delete(`${api}/payload-locked-documents/${lockId}`);
  } finally {
    await request.delete(`${api}/users/${editorId}`);
  }
};

/** The script an agent sends to bring back a version of the site settings. */
const restoreGlobalScript = (options: {
  expected: string;
  marker: string;
  versionId: number | string;
}) => `async () => payload.apply({
  intent: "Put the site tagline back for launch-verify run ${options.marker}",
  operations: [{
    kind: "restore_global_version",
    global: "site-settings",
    version_id: ${JSON.stringify(options.versionId)},
    expected_updated_at: ${JSON.stringify(options.expected)},
    publish: true,
  }],
})`;

/** A change to the tagline, and what it is checked against. */
interface TaglineChange {
  expected: string;
  from: string;
  /** Set to bring back this version instead of sending the tagline. */
  restore?: number | string;
  shot: string;
  to: string;
}

/**
 * Changes the tagline with `publish: true`, by sending it or by restoring a
 * version that holds it, approves it, and gives back when the receipt says
 * the global was last updated.
 */
const approveGlobal = async (
  run: DriveRun,
  page: Page,
  change: TaglineChange
): Promise<string> => {
  const { executionId, preview } = await openApproval(
    run,
    page,
    change.restore === undefined
      ? globalScript({
          expected: change.expected,
          marker: run.marker,
          publish: true,
          tagline: change.to,
        })
      : restoreGlobalScript({
          expected: change.expected,
          marker: run.marker,
          versionId: change.restore,
        })
  );

  const warned = preview.includes("live as soon as you approve");

  const shown = [change.from, change.to].every((text) =>
    preview.includes(text)
  );

  run.expect(warned, "the approval page does not warn that the change is live");
  run.expect(
    shown,
    "the approval page does not show the tagline before and after"
  );
  await run.log.shot(page, `${change.shot}-approval`);

  const outcome = await approve(page);

  await run.log.shot(page, `${change.shot}-approved`);

  const record = await runRecord(run, executionId);
  const receipt = JSON.stringify(record);

  writeFileSync(
    path.join(run.dir, `${change.shot}-run.json`),
    `${JSON.stringify(record, null, 2)}\n`
  );

  const landed = [
    '"status":"succeeded"',
    '"changed_paths":["tagline"]',
    '"version_id":"',
  ].every((text) => receipt.includes(text));

  const sent =
    change.restore === undefined
      ? `update_global with publish: true, tagline "${change.to}"`
      : `restore_global_version ${change.restore} with publish: true, which holds tagline "${change.to}"`;

  run.expect(
    landed,
    `get_run does not report tagline as changed with a version: ${receipt.slice(0, 300)}`
  );
  run.log.step(
    `execute: payload.apply ${sent}; approve it`,
    `warns that it is live at once: ${warned}; shows before and after: ${shown}; ${outcome.slice(outcome.indexOf("Result:")).slice(0, 48)}; receipt lists tagline with a version: ${landed} (${change.shot}-run.json)`
  );

  return /"updated_at":"(?<stamp>[^"]+)"/u.exec(receipt)?.groups?.stamp ?? "";
};

/** The id of the site settings' newest version, read as the local admin. */
const newestSettingsVersion = async (
  admin: Page,
  payloadOrigin: string
): Promise<number | string> => {
  const response = await admin.request.get(
    `${payloadOrigin}/api/globals/site-settings/versions?depth=0&limit=1&sort=-updatedAt`
  );

  const found: { docs?: { id: number | string }[] } = await response.json();
  const id = found.docs?.at(0)?.id;

  if (id === undefined) {
    throw new Error("The site settings have no version: seed Payload first.");
  }

  return id;
};

/**
 * MCP gateway: an editor's agent changes a global. The site settings keep no
 * drafts, so a change that does not say it publishes is refused, the
 * approval warns that the change is live at once, the public API shows it
 * the moment it is approved, and restoring the version from before the
 * change, built on the first receipt, puts the tagline back.
 */
const mcpPayloadGlobal: Drive = async ({
  origin,
  dir,
  repoRoot,
  peers,
  signIn,
}) => {
  const payloadOrigin = peers.payload;

  if (!payloadOrigin) {
    throw new Error("No owned payload server; launch mcp first.");
  }

  const marker = `verify-${randomUUID().slice(0, 8)}`;
  const log = transcript(dir);
  const browser = await openBrowser(repoRoot);
  const failures: string[] = [];

  try {
    const admin = await openLocalAdmin(browser, payloadOrigin);
    const email = await adminEmail(admin, payloadOrigin);
    const token = signIn(email);

    const run: DriveRun = {
      dir,
      expect: (pass, what) => {
        if (!pass) {
          failures.push(what);
        }
      },
      log,
      marker,
      origin,
      token,
    };

    log.step(
      "Sign in to the gateway as the local admin",
      `${email}, with a JWT signed by the local Access stand-in`
    );

    const read = await execute<SettingsSummary>(origin, token, READ_SETTINGS);
    const settings = read.structuredContent.result;

    if (!settings?.tagline) {
      throw new Error("The site settings have no tagline: seed Payload first.");
    }

    const before = settings.tagline;
    const tagline = `${before.replace(MARKER, "")} (${marker})`;

    log.step(
      "execute: read the site-settings global through payload.call",
      `tagline "${before}", updated ${settings.updatedAt}`
    );

    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
      viewport: { height: 900, width: 1280 },
    });

    const page = await context.newPage();
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    await refusedRequest(run, page, {
      code: globalScript({
        expected: settings.updatedAt,
        marker,
        publish: false,
        tagline,
      }),
      reason: "publish_required",
      shot: "no-publish-refused",
      what: "a change to a global without drafts that does not say publish: true",
    });
    await refusedRequest(run, page, {
      code: globalScript({
        expected: "2020-01-01T00:00:00.000Z",
        marker,
        publish: true,
        tagline,
      }),
      reason: "stale_expected_updated_at",
      shot: "stale-refused",
      what: "a request with a stale expected_updated_at",
    });
    await refusedWhileLocked(run, page, {
      admin,
      code: globalScript({
        expected: settings.updatedAt,
        marker,
        publish: true,
        tagline,
      }),
      lock: {
        data: { globalSlug: "site-settings" },
        named: "the site settings",
        what: "a change to a global",
      },
      payloadOrigin,
    });

    // The version to come back to at the end: the settings as they are now.
    const firstVersion = await newestSettingsVersion(admin, payloadOrigin);

    await admin.close();

    const changedAt = await approveGlobal(run, page, {
      expected: settings.updatedAt,
      from: before,
      shot: "change",
      to: tagline,
    });

    const live = await publicSettings(payloadOrigin);

    run.expect(
      live.tagline === tagline,
      `the public API does not show the new tagline: "${live.tagline}"`
    );
    run.expect(
      live.siteName === settings.siteName,
      "the site name changed; only the tagline was sent"
    );
    log.step(
      "Read the global from the public API",
      `tagline "${live.tagline}"; site name still "${live.siteName}": ${live.siteName === settings.siteName}`
    );

    // Built on the first receipt's `updated_at`, the way an agent chains a
    // second write without reading again. It brings back the version from
    // before the change, which leaves the site as it was.
    await approveGlobal(run, page, {
      expected: changedAt,
      from: tagline,
      restore: firstVersion,
      shot: "restore",
      to: before,
    });

    const restored = await publicSettings(payloadOrigin);

    run.expect(
      restored.tagline === before,
      `the tagline was not put back: "${restored.tagline}"`
    );
    log.step(
      "Put the tagline back by restoring the version from before the change, built on the first receipt's updated_at",
      `public tagline "${restored.tagline}"`
    );

    log.step(
      "Browser console errors on the approval pages",
      errors.length ? errors.join(" | ") : "none"
    );
    await context.close();
  } finally {
    log.write();
    await browser.close();
  }

  if (failures.length > 0) {
    throw new Error(`payload-global failed: ${failures.join("; ")}`);
  }
};

/** What READ_LIVE_POST returns: a post as its newest version stands. */
interface LivePost {
  id: number;
  slug: string;
  status: string;
  title: string;
  updatedAt: string;
}

// One post's newest version through the gateway. With `_status` published in
// `where`, it is a post with no draft saved since it was published: the
// public sees exactly what this read returns.
const READ_LIVE_POST = (where: string) => `async () => {
  const found = await payload.call({
    tool: "findDocuments",
    arguments: { slug: "posts", draft: true, depth: 0, limit: 1, sort: "title", where: ${where} },
  });
  const block = /\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/.exec(found.text);
  const doc = [].concat(JSON.parse(block ? block[1] : "null"))[0];
  return doc ? { id: doc.id, slug: doc.slug, status: doc._status, title: doc.title, updatedAt: doc.updatedAt } : null;
}`;

const readLivePost = async (
  run: Session,
  where: string
): Promise<LivePost | null> => {
  const read = await execute<LivePost>(
    run.origin,
    run.token,
    READ_LIVE_POST(where)
  );

  return read.structuredContent.result ?? null;
};

/** One operation on a post, as this drive sends it. */
interface PostOperation {
  collection: "posts";
  expected_updated_at: string;
  fields?: { slug?: string; title: string };
  id: number;
  kind: "restore_version" | "unpublish" | "update_draft";
  publish?: true;
  version_id?: number | string;
}

const postScript = (marker: string, operation: PostOperation) =>
  `async () => payload.apply({
  intent: "Change a post and put it back for launch-verify run ${marker}",
  operations: [${JSON.stringify(operation)}],
})`;

/** A post as an anonymous visitor's API read answers: its status code and title. */
const publicPost = async (
  payloadOrigin: string,
  id: number
): Promise<{ status: number; title?: string }> => {
  const response = await fetch(`${payloadOrigin}/api/posts/${id}?depth=0`);
  const post: { title?: string } = await response.json();

  return post.title === undefined
    ? { status: response.status }
    : { status: response.status, title: post.title };
};

/** The status code the front end answers a path with. */
const pageStatus = async (
  payloadOrigin: string,
  pagePath: string
): Promise<number> => {
  const response = await fetch(`${payloadOrigin}${pagePath}`, {
    redirect: "manual",
  });

  return response.status;
};

/** What an approved write left behind. */
interface Approved {
  preview: string;
  receipt: string;
  /** The receipt's `updated_at`: what the next write is built on. */
  updatedAt: string;
}

/** Sends one operation on a post, approves it and reads its receipt. */
const approvePost = async (
  run: DriveRun,
  page: Page,
  request: { operation: PostOperation; shot: string }
): Promise<Approved> => {
  const { executionId, preview } = await openApproval(
    run,
    page,
    postScript(run.marker, request.operation)
  );

  await run.log.shot(page, `${request.shot}-approval`);

  const outcome = await approve(page);
  const record = await runRecord(run, executionId);
  const receipt = JSON.stringify(record);

  writeFileSync(
    path.join(run.dir, `${request.shot}-run.json`),
    `${JSON.stringify(record, null, 2)}\n`
  );
  run.expect(
    receipt.includes('"status":"succeeded"'),
    `${request.shot} did not succeed: ${outcome.slice(outcome.indexOf("Result:")).slice(0, 200)}`
  );

  return {
    preview,
    receipt,
    updatedAt:
      /"updated_at":"(?<stamp>[^"]+)"/u.exec(receipt)?.groups?.stamp ?? "",
  };
};

/**
 * Takes the post down and checks every place that shows it: the approval
 * warned where the page is, the receipt reports the status, the public API
 * and the front end no longer serve it, and the draft is as it was.
 */
const unpublishPost = async (
  run: DriveRun,
  page: Page,
  post: {
    draftTitle: string;
    expected: string;
    id: number;
    payload: string;
    pagePath: string;
  }
): Promise<Approved> => {
  const unpublished = await approvePost(run, page, {
    operation: {
      collection: "posts",
      expected_updated_at: post.expected,
      id: post.id,
      kind: "unpublish",
    },
    shot: "unpublish",
  });

  const warned = [
    `The public page at ${post.pagePath} goes away as soon as you approve`,
    "Links to it will 404 unless a redirect covers them",
  ].every((text) => unpublished.preview.includes(text));

  const reported = ['"changed_paths":["_status"]', '"version_id":"'].every(
    (text) => unpublished.receipt.includes(text)
  );

  run.expect(
    warned,
    "the approval page does not say where the page is and that links will 404"
  );
  run.expect(
    reported,
    `get_run does not report _status as changed with a version: ${unpublished.receipt.slice(0, 300)}`
  );

  const api = await publicPost(post.payload, post.id);
  const front = await pageStatus(post.payload, post.pagePath);
  const draft = await readLivePost(run, `{ id: { equals: ${post.id} } }`);

  run.expect(
    api.title === undefined,
    `the public API still serves the post: ${api.status}`
  );
  run.expect(front === 404, `the front end still serves the page: ${front}`);
  run.expect(
    draft?.title === post.draftTitle && draft.status === "draft",
    `the draft did not keep its content: "${draft?.title}" (${draft?.status})`
  );
  run.log.step(
    "execute: payload.apply unpublish; approve it",
    `warns where the page is and that links will 404: ${warned}; receipt lists _status with a version: ${reported} (unpublish-run.json); public API answers ${api.status}; ${post.pagePath} answers ${front}; draft is still "${draft?.title}" (${draft?.status})`
  );

  return unpublished;
};

/**
 * MCP gateway: an editor's agent takes a published post off the site. The
 * post first gets a newer draft, so the drive can see that unpublishing
 * keeps it; the approval says where the public page is; once approved the
 * public API and the front end stop serving the post; a second unpublish is
 * refused; and publishing the post again puts everything back.
 */
const mcpPayloadUnpublish: Drive = async ({
  origin,
  dir,
  repoRoot,
  peers,
  signIn,
}) => {
  const payloadOrigin = peers.payload;

  if (!payloadOrigin) {
    throw new Error("No owned payload server; launch mcp first.");
  }

  const marker = `verify-${randomUUID().slice(0, 8)}`;
  const log = transcript(dir);
  const browser = await openBrowser(repoRoot);
  const failures: string[] = [];

  try {
    const email = await localAdminEmail(browser, payloadOrigin);
    const token = signIn(email);

    const run: DriveRun = {
      dir,
      expect: (pass, what) => {
        if (!pass) {
          failures.push(what);
        }
      },
      log,
      marker,
      origin,
      token,
    };

    log.step(
      "Sign in to the gateway as the local admin",
      `${email}, with a JWT signed by the local Access stand-in`
    );

    const post = await readLivePost(
      run,
      '{ _status: { equals: "published" } }'
    );

    if (!post) {
      throw new Error(
        "No published post without a newer draft: seed Payload first."
      );
    }

    const pagePath = `/news/${post.slug}`;
    const draftTitle = `${post.title} (${marker})`;
    const before = await pageStatus(payloadOrigin, pagePath);

    run.expect(before === 200, `${pagePath} answers ${before} before the run`);
    log.step(
      "execute: read a published post with no newer draft",
      `posts/${post.id} "${post.title}", updated ${post.updatedAt}; ${pagePath} answers ${before}`
    );

    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
      viewport: { height: 900, width: 1280 },
    });

    const page = await context.newPage();
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    // A draft saved after the post was published, so there is something for
    // unpublishing to keep. It carries another slug too: the page that goes
    // away is still the published one, at the first slug.
    const drafted = await approvePost(run, page, {
      operation: {
        collection: "posts",
        expected_updated_at: post.updatedAt,
        fields: { slug: `${post.slug}-${marker}`, title: draftTitle },
        id: post.id,
        kind: "update_draft",
      },
      shot: "draft",
    });

    const stillPublic = await publicPost(payloadOrigin, post.id);

    log.step(
      "execute: payload.apply update_draft giving the post another title and slug as a draft; approve it",
      `draft title "${draftTitle}", draft slug "${post.slug}-${marker}"; the public still sees "${stillPublic.title}"`
    );

    await refusedRequest(run, page, {
      code: postScript(marker, {
        collection: "posts",
        expected_updated_at: post.updatedAt,
        id: post.id,
        kind: "unpublish",
      }),
      reason: "stale_expected_updated_at",
      shot: "stale-refused",
      what: "an unpublish built on a read from before the draft",
    });

    const unpublished = await unpublishPost(run, page, {
      draftTitle,
      expected: drafted.updatedAt,
      id: post.id,
      pagePath,
      payload: payloadOrigin,
    });

    await refusedRequest(run, page, {
      code: postScript(marker, {
        collection: "posts",
        expected_updated_at: unpublished.updatedAt,
        id: post.id,
        kind: "unpublish",
      }),
      reason: "already_draft",
      shot: "already-draft-refused",
      what: "a second unpublish of the same post",
    });

    // Put back: the title as it was, published.
    await approvePost(run, page, {
      operation: {
        collection: "posts",
        expected_updated_at: unpublished.updatedAt,
        fields: { slug: post.slug, title: post.title },
        id: post.id,
        kind: "update_draft",
        publish: true,
      },
      shot: "republish",
    });

    const restored = await publicPost(payloadOrigin, post.id);
    const after = await pageStatus(payloadOrigin, pagePath);

    run.expect(
      restored.title === post.title,
      `the post was not put back: ${restored.status} "${restored.title}"`
    );
    run.expect(
      after === 200,
      `${pagePath} answers ${after} after republishing`
    );
    log.step(
      "Publish the post again with its first title and slug, built on the unpublish receipt's updated_at",
      `public API title "${restored.title}"; ${pagePath} answers ${after}`
    );

    log.step(
      "Browser console errors on the approval pages",
      errors.length ? errors.join(" | ") : "none"
    );
    await context.close();
  } finally {
    log.write();
    await browser.close();
  }

  if (failures.length > 0) {
    throw new Error(`payload-unpublish failed: ${failures.join("; ")}`);
  }
};

/** What READ_VERSIONS returns for each version. */
interface PostVersion {
  id: number | string;
  parent: number | string;
  status: string;
  title: string;
}

// A post's versions through the gateway, newest first, as Payload's own
// read tool answers: a heading and one fenced JSON block.
const READ_VERSIONS = (where: string) => `async () => {
  const found = await payload.call({
    tool: "findVersions",
    arguments: { slug: "posts", depth: 0, limit: 10, sort: "-updatedAt", where: ${where} },
  });
  const block = /\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/.exec(found.text);
  const docs = JSON.parse(block ? block[1] : "{}").docs ?? [];
  return docs.map((doc) => ({ id: doc.id, parent: doc.parent, status: doc.version._status, title: doc.version.title }));
}`;

const readVersions = async (
  run: Session,
  where: string
): Promise<PostVersion[]> => {
  const read = await execute<PostVersion[]>(
    run.origin,
    run.token,
    READ_VERSIONS(where)
  );

  return read.structuredContent.result ?? [];
};

/** The receipt's `version_id`: the version an approved write made. */
const madeVersion = (approved: Approved): string =>
  /"version_id":"(?<id>[^"]+)"/u.exec(approved.receipt)?.groups?.id ?? "";

/** What the restore drive carries about its post. */
interface RestoredPost {
  draftTitle: string;
  id: number;
  payload: string;
  title: string;
}

/**
 * Brings the published version back as a draft: the approval names the
 * version and shows the title before and after, the receipt lists the
 * title, the newest draft has the first title again, and the public saw
 * the same post throughout.
 */
const restoreAsDraft = async (
  run: DriveRun,
  page: Page,
  request: { expected: string; post: RestoredPost; versionId: number | string }
): Promise<Approved> => {
  const { post } = request;

  const restored = await approvePost(run, page, {
    operation: {
      collection: "posts",
      expected_updated_at: request.expected,
      id: post.id,
      kind: "restore_version",
      version_id: request.versionId,
    },
    shot: "restore",
  });

  const shown = [
    `version ${request.versionId}, saved`,
    post.draftTitle,
    post.title,
  ].every((text) => restored.preview.includes(text));

  const reported = [
    '"changed_paths":["title"]',
    `"restored_version_id":"${request.versionId}"`,
    '"version_id":"',
  ].every((text) => restored.receipt.includes(text));

  const draft = await readLivePost(run, `{ id: { equals: ${post.id} } }`);
  const live = await publicPost(post.payload, post.id);

  run.expect(shown, "the approval page does not show the version and titles");
  run.expect(reported, "the receipt does not list the title and the version");
  run.expect(
    draft?.title === post.title && draft.status === "draft",
    `the newest draft is "${draft?.title}" (${draft?.status})`
  );
  run.expect(
    live.title === post.title,
    `the public sees "${live.title}" after a restore as a draft`
  );
  run.log.step(
    `execute: payload.apply restore_version ${request.versionId}, the published one, as a draft; approve it`,
    `shows the version and the title before and after: ${shown}; receipt lists title, the restored version and a new version: ${reported} (restore-run.json); newest draft is "${draft?.title}" (${draft?.status}); the public still sees "${live.title}"`
  );

  return restored;
};

/**
 * Brings the retitled draft back and publishes it, which the gateway does
 * in two writes: the public now sees the draft's title.
 */
const restoreAndPublish = async (
  run: DriveRun,
  page: Page,
  request: { expected: string; post: RestoredPost; versionId: string }
): Promise<Approved> => {
  const { post } = request;

  const published = await approvePost(run, page, {
    operation: {
      collection: "posts",
      expected_updated_at: request.expected,
      id: post.id,
      kind: "restore_version",
      publish: true,
      version_id: request.versionId,
    },
    shot: "restore-publish",
  });

  const reported = published.receipt.includes(
    '"changed_paths":["title","_status"]'
  );

  const live = await publicPost(post.payload, post.id);

  run.expect(reported, "the receipt does not list the title and _status");
  run.expect(
    live.title === post.draftTitle,
    `the public sees "${live.title}" after a restore that publishes`
  );
  run.log.step(
    `execute: payload.apply restore_version ${request.versionId}, the retitled draft, with publish: true; approve it`,
    `receipt lists title and _status: ${reported} (restore-publish-run.json); the public now sees "${live.title}"`
  );

  return published;
};

/** The requests about a post's versions that must not reach an approval. */
const refusedRestores = async (
  run: DriveRun,
  page: Page,
  request: {
    admin: Page;
    expected: string;
    post: RestoredPost;
    stale: string;
    versionId: number | string;
  }
): Promise<void> => {
  const { post } = request;

  const restore = (rest: Partial<PostOperation>): string =>
    postScript(run.marker, {
      collection: "posts",
      expected_updated_at: request.expected,
      id: post.id,
      kind: "restore_version",
      version_id: request.versionId,
      ...rest,
    });

  const [other] = await readVersions(
    run,
    `{ parent: { not_equals: ${post.id} } }`
  );

  if (!other) {
    throw new Error("No version of another post: seed Payload first.");
  }

  await refusedRequest(run, page, {
    code: restore({ expected_updated_at: request.stale }),
    reason: "stale_expected_updated_at",
    shot: "stale-refused",
    what: "a restore built on a read from before the draft",
  });
  await refusedRequest(run, page, {
    code: restore({ version_id: other.id }),
    reason: "version_of_another_document",
    shot: "other-document-refused",
    what: `a restore of version ${other.id}, which is posts/${other.parent}'s`,
  });
  await refusedWhileLocked(run, page, {
    admin: request.admin,
    code: restore({}),
    lock: {
      data: { document: { relationTo: "posts", value: post.id } },
      named: `posts/${post.id}`,
      what: "a restore of a post",
    },
    payloadOrigin: post.payload,
  });
};

/**
 * Restoring versions, end to end: a published post gets a retitled draft,
 * the published version is restored as a draft, then the retitled one is
 * restored and published, and the post is put back as it was.
 */
const mcpPayloadRestore: Drive = async ({
  origin,
  dir,
  repoRoot,
  peers,
  signIn,
}) => {
  const payloadOrigin = peers.payload;

  if (!payloadOrigin) {
    throw new Error("No owned payload server; launch mcp first.");
  }

  const marker = `verify-${randomUUID().slice(0, 8)}`;
  const log = transcript(dir);
  const browser = await openBrowser(repoRoot);
  const failures: string[] = [];

  try {
    const admin = await openLocalAdmin(browser, payloadOrigin);
    const email = await adminEmail(admin, payloadOrigin);
    const token = signIn(email);

    const run: DriveRun = {
      dir,
      expect: (pass, what) => {
        if (!pass) {
          failures.push(what);
        }
      },
      log,
      marker,
      origin,
      token,
    };

    log.step(
      "Sign in to the gateway as the local admin",
      `${email}, with a JWT signed by the local Access stand-in`
    );

    const live = await readLivePost(
      run,
      '{ _status: { equals: "published" } }'
    );

    if (!live) {
      throw new Error(
        "No published post without a newer draft: seed Payload first."
      );
    }

    const post: RestoredPost = {
      draftTitle: `${live.title} (${marker})`,
      id: live.id,
      payload: payloadOrigin,
      title: live.title,
    };

    const [published] = await readVersions(
      run,
      `{ parent: { equals: ${live.id} } }`
    );

    if (published?.status !== "published") {
      throw new Error(`posts/${live.id} has no published newest version.`);
    }

    log.step(
      "execute: read a published post with no newer draft, and its newest version",
      `posts/${live.id} "${live.title}", updated ${live.updatedAt}; version ${published.id} (${published.status})`
    );

    const context = await browser.newContext({
      extraHTTPHeaders: { "cf-access-jwt-assertion": token },
      viewport: { height: 900, width: 1280 },
    });

    const page = await context.newPage();
    const errors: string[] = [];

    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    const drafted = await approvePost(run, page, {
      operation: {
        collection: "posts",
        expected_updated_at: live.updatedAt,
        fields: { title: post.draftTitle },
        id: live.id,
        kind: "update_draft",
      },
      shot: "draft",
    });

    log.step(
      "execute: payload.apply update_draft retitling the post as a draft; approve it",
      `draft title "${post.draftTitle}", version ${madeVersion(drafted)}`
    );

    await refusedRestores(run, page, {
      admin,
      expected: drafted.updatedAt,
      post,
      stale: live.updatedAt,
      versionId: published.id,
    });
    await admin.close();

    const restored = await restoreAsDraft(run, page, {
      expected: drafted.updatedAt,
      post,
      versionId: published.id,
    });

    const republished = await restoreAndPublish(run, page, {
      expected: restored.updatedAt,
      post,
      versionId: madeVersion(drafted),
    });

    // Put back: the first title, published, with no draft after it.
    await approvePost(run, page, {
      operation: {
        collection: "posts",
        expected_updated_at: republished.updatedAt,
        fields: { title: post.title },
        id: live.id,
        kind: "update_draft",
        publish: true,
      },
      shot: "put-back",
    });

    const after = await publicPost(payloadOrigin, live.id);

    run.expect(
      after.title === post.title,
      `the post was not put back: "${after.title}"`
    );
    log.step(
      "Publish the post again with its first title, built on the last receipt's updated_at",
      `public API title "${after.title}"`
    );

    log.step(
      "Browser console errors on the approval pages",
      errors.length ? errors.join(" | ") : "none"
    );
    await context.close();
  } finally {
    log.write();
    await browser.close();
  }

  if (failures.length > 0) {
    throw new Error(`payload-restore failed: ${failures.join("; ")}`);
  }
};

export const DRIVES = new Map<string, Map<string, Drive>>([
  [
    "mcp",
    new Map([
      ["payload-draft", mcpPayloadDraft],
      ["payload-global", mcpPayloadGlobal],
      ["payload-restore", mcpPayloadRestore],
      ["payload-rows", mcpPayloadRows],
      ["payload-unpublish", mcpPayloadUnpublish],
      ["payload-upload", mcpPayloadUpload],
    ]),
  ],
  [
    "payload",
    new Map([
      ["apply-form", payloadApplyForm],
      [
        "pages",
        pagesSmoke(["/", "/programs", "/programs/seed-library", "/news"]),
      ],
      ["seo", payloadSeo],
    ]),
  ],
  [
    "web-wordpress",
    new Map([
      [
        "pages",
        pagesSmoke(["/", "/about", "/programs", "/programs/seed-library"]),
      ],
    ]),
  ],
]);
