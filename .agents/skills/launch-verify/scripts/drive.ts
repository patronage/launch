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

import type { BrowserType, Page } from "playwright";

export interface DriveContext {
  origin: string;
  dir: string;
  repoRoot: string;
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

export const DRIVES = new Map<string, Map<string, Drive>>([
  [
    "payload",
    new Map([
      ["apply-form", payloadApplyForm],
      [
        "pages",
        pagesSmoke(["/", "/programs", "/programs/seed-library", "/news"]),
      ],
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
