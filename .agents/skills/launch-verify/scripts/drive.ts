// Scripted browser drives for launch-verify, on the repo's own Playwright (the
// one apps/payload's smoke test uses). verify.ts calls these; each writes a
// transcript, numbered screenshots and any side-effect proof to its evidence
// directory.
//
// Each drive is one user's path, step by step, so awaiting inside loops is
// the point here, not an accident.
/* oxlint-disable no-await-in-loop */
import { randomUUID } from "node:crypto";
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
  id: number;
  status: string;
  title: string;
  updatedAt: string;
}

/** The parts of the gateway's structured tool results this drive reads. */
interface StructuredContent {
  approvalUrl?: string;
  executionId?: string;
  result?: PostSummary | null;
  status?: string;
}

/** The parts of an MCP JSON-RPC result this drive reads. */
interface RpcResult {
  content?: { text?: string; type: string }[];
  structuredContent?: StructuredContent;
  tools?: { name: string }[];
}

/** The two gateway tools this drive calls. */
type ToolArguments = { code: string } | { executionId: string };

interface ToolCall {
  arguments: ToolArguments;
  name: string;
}

interface ToolResult {
  structuredContent: StructuredContent;
  text: string;
}

/**
 * One MCP request to the local gateway, as a client that is not a browser
 * sends it: JSON-RPC over Streamable HTTP, answered as JSON or as one event.
 */
const mcpRequest = async (
  origin: string,
  token: string | null,
  method: "tools/call" | "tools/list",
  params?: ToolCall
): Promise<{ result?: RpcResult; status: number }> => {
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
    const parsed: { result?: RpcResult } = JSON.parse(json);

    return { result: parsed.result, status: response.status };
  } catch {
    return { status: response.status };
  }
};

const callTool = async (
  origin: string,
  token: string,
  name: string,
  args: ToolArguments
): Promise<ToolResult> => {
  const { result, status } = await mcpRequest(origin, token, "tools/call", {
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

/** Runs one script through the gateway's `execute` tool. */
const execute = (origin: string, token: string, code: string) =>
  callTool(origin, token, "execute", { code });

// A findDocuments answer is a heading and one fenced JSON block, holding one
// document or a list of them.
const READ_POST = (where: string) => `async () => {
  const found = await payload.call({
    tool: "findDocuments",
    arguments: { slug: "posts", draft: true, depth: 0, limit: 1, ${where} },
  });
  const block = /\`\`\`json\\n([\\s\\S]*?)\\n\`\`\`/.exec(found.text);
  const doc = [].concat(JSON.parse(block ? block[1] : "null"))[0];
  return doc ? { id: doc.id, title: doc.title, updatedAt: doc.updatedAt, status: doc._status } : null;
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
const localAdminEmail = async (
  browser: Browser,
  payloadOrigin: string
): Promise<string> => {
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

  const response = await admin.request.get(`${payloadOrigin}/api/users/me`);
  const me: { user?: { email?: string } } = await response.json();

  await admin.close();

  if (!me.user?.email) {
    throw new Error("Could not sign in to the local Payload admin.");
  }

  return me.user.email;
};

/** The script an agent sends to retitle one post as a draft. */
const retitleScript = (options: {
  expected: string;
  id: number;
  marker: string;
  title: string;
}) => `async () => payload.apply({
  intent: "Retitle a post for launch-verify run ${options.marker}",
  operations: [{
    kind: "update_draft",
    collection: "posts",
    id: ${options.id},
    fields: { title: ${JSON.stringify(options.title)} },
    expected_updated_at: ${JSON.stringify(options.expected)},
  }],
})`;

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

    const listed = await mcpRequest(origin, token, "tools/list");
    const tools = (listed.result?.tools ?? []).map((tool) => tool.name);

    expect(tools.includes("execute"), "the gateway lists no execute tool");
    log.step("POST /mcp tools/list, signed in", tools.join(", "));

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
    const request = { id: post.id, marker, title };

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
    log.step(
      "Open the approval page",
      `shows the new title: ${preview.includes(marker)}; shows the old title: ${preview.includes(post.title)}`
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
    expect(
      receipt.includes('"status":"succeeded"') &&
        receipt.includes('"status":"changed"'),
      "get_run reports no successful change"
    );
    log.step(
      "get_run for the approved run",
      `succeeded: ${receipt.includes('"status":"succeeded"')}; title changed: ${receipt.includes('"changed_paths":["title"]')} (run.json)`
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

export const DRIVES = new Map<string, Map<string, Drive>>([
  ["mcp", new Map([["payload-draft", mcpPayloadDraft]])],
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
