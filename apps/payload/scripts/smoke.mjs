// End-to-end check of a local Worker with an empty database:
//   pnpm build && pnpm preview, then pnpm smoke [url]
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { chromium } from "playwright";

const base = process.argv[2] ?? "http://localhost:4173";
const timeout = 60_000;

// An 8x8 red PNG to upload as media.
const hero = path.join(tmpdir(), "launch-payload-smoke.png");

writeFileSync(
  hero,
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAAEklEQVR4nGP4z8CAFWEXHbQSACj/P8Fu7N9hAAAAAElFTkSuQmCC",
    "base64"
  )
);

const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];

page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`));

page.on("console", (message) => {
  if (message.type() === "error") {
    errors.push(`console: ${message.text()}`);
  }
});

const step = async (name, fn) => {
  const start = Date.now();

  await fn();
  console.log("ok", name, `${Date.now() - start}ms`);
};

// Fetches a page in a fresh context, so as an anonymous visitor.
const anonymousGet = async (pathname) => {
  const context = await browser.newContext();
  const anonymous = await context.newPage();
  const response = await anonymous.goto(`${base}${pathname}`);
  const html = await anonymous.content();

  await context.close();

  return { html, status: response.status() };
};

const json = async (response) => {
  if (!response.ok()) {
    throw new Error(`${response.url()} returned ${response.status()}`);
  }

  return await response.json();
};

try {
  let pageUrl = "";

  await step("admin redirects to create-first-user", async () => {
    await page.goto(`${base}/admin`);
    await page.waitForURL(/create-first-user/u, { timeout });
    // Wait for the admin to hydrate before typing into it.
    await page.waitForLoadState("networkidle");
  });

  await step("create first user", async () => {
    await page.fill("#field-email", "dev@example.com");
    await page.fill("#field-password", "password123");
    await page.fill("#field-confirm-password", "password123");
    await page.click("button[type=submit]");
    await page.waitForURL(
      (url) => !url.pathname.includes("create-first-user"),
      {
        timeout,
      }
    );
  });

  await step("upload media to R2", async () => {
    await page.goto(`${base}/admin/collections/media/create`);
    await page.setInputFiles("input[type=file]", hero);
    await page.fill("#field-alt", "Red square");
    await page.click("#action-save");
    await page.waitForURL(/\/collections\/media\/\d+/u, { timeout });
  });

  await step("edit global", async () => {
    await page.goto(`${base}/admin/globals/site-settings`);
    await page.fill("#field-tagline", "Running on vinext");
    await page.click("#action-save");
    await page.waitForSelector("text=Updated successfully", { timeout });
  });

  await step("save a draft page with Lexical rich text", async () => {
    await page.goto(`${base}/admin/collections/pages/create`);
    // Wait for the editor to hydrate, or it drops the first keystrokes.
    await page.waitForLoadState("networkidle");
    await page.fill("#field-title", "Hello vinext");
    await page.fill("#field-slug", "hello");
    await page.locator('[data-lexical-editor="true"]').first().click();
    await page.keyboard.type("Rich text from Lexical.");
    await page.click("#action-save-draft");
    await page.waitForURL(/\/collections\/pages\/\d+/u, { timeout });
    pageUrl = page.url();
  });

  await step("anonymous visitor cannot see the draft", async () => {
    const { status } = await anonymousGet("/hello");
    const home = await anonymousGet("/");

    if (status !== 404) {
      throw new Error(`expected 404, got ${status}`);
    }

    if (home.html.includes("Hello vinext")) {
      throw new Error("draft listed on the home page");
    }
  });

  await step("signed-in editor sees the draft", async () => {
    const response = await page.goto(`${base}/hello`);

    if (response.status() !== 200) {
      throw new Error(`editor got ${response.status()}`);
    }
  });

  await step("attach hero over REST and publish in the admin", async () => {
    const id = pageUrl.split("/").pop();

    const media = await json(
      await page.request.get(`${base}/api/media?limit=1`)
    );

    await json(
      await page.request.patch(`${base}/api/pages/${id}?draft=true`, {
        data: { hero: { image: media.docs[0].id, variant: "media" } },
      })
    );
    await page.goto(pageUrl);
    await page.click("#action-save");
    await page.waitForSelector("text=Updated successfully", { timeout });
  });

  await step(
    "anonymous visitor sees the published page and R2 image",
    async () => {
      const { html, status } = await anonymousGet("/hello");
      const home = await anonymousGet("/");
      const src = /<img[^>]+src="(?<src>[^"]+)"/u.exec(html)?.groups?.src;

      if (status !== 200) {
        throw new Error(`expected 200, got ${status}`);
      }

      if (!html.includes("Rich text from Lexical.")) {
        throw new Error("rich text missing");
      }

      if (!src) {
        throw new Error("hero image missing");
      }

      const image = await page.request.get(`${base}${src}`);

      // The front end serves media from /media, resized by the Images binding.
      if (
        !(src.startsWith("/media/") && image.ok()) ||
        !image.headers()["content-type"]?.startsWith("image/")
      ) {
        throw new Error(`image ${src} returned ${image.status()}`);
      }

      if (
        !(
          home.html.includes("Running on vinext") &&
          home.html.includes("Hello vinext")
        )
      ) {
        throw new Error("home page is missing the global or the page");
      }
    }
  );

  await step("GraphQL", async () => {
    const result = await json(
      await page.request.post(`${base}/api/graphql`, {
        data: { query: "{ Pages { docs { title } } }" },
      })
    );

    if (result.data.Pages.docs[0]?.title !== "Hello vinext") {
      throw new Error(JSON.stringify(result));
    }
  });
} catch (error) {
  console.log("FAIL", error.message.split("\n")[0], "at", page.url());
  console.log(errors.slice(0, 10).join("\n"));
  process.exitCode = 1;
}

await browser.close();
