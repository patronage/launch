import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST } from "./route";

const transport = vi.hoisted(() => ({
  wordpressFetch:
    vi.fn<(input: string, init?: RequestInit) => Promise<Response>>(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; stands in for WordPress, so the test needs no network.
vi.mock("@/lib/wordpress/fetch", () => transport);

const SECRET = "forms-secret";
const MAX_BODY_BYTES = 64 * 1024;

const submission = { formId: "7", values: { email: "visitor@example.org" } };

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("https://site.example.org/forms/submit", {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  });

const answer = (body: { message?: string; ok?: boolean }, status: number) =>
  Response.json(body, { status });

const messageOf = async (response: Response): Promise<string | undefined> => {
  // SAFETY: the route always answers JSON with an optional message.
  const body = (await response.json()) as { message?: string };

  return body.message;
};

describe("POST /forms/submit", () => {
  beforeEach(() => {
    vi.stubEnv("WORDPRESS_URL", "https://cms.example.org");
    vi.stubEnv("HEADLESS_SECRET", SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it("passes the submission to the theme's form route with the shared secret", async () => {
    transport.wordpressFetch.mockResolvedValue(answer({ ok: true }, 200));

    const response = await POST(post(JSON.stringify(submission)));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toStrictEqual({ ok: true });

    const [input, init] = transport.wordpressFetch.mock.calls[0] ?? [];

    expect(input).toBe(
      "https://cms.example.org/wp-json/patronage/v1/forms/7/submissions"
    );
    expect(new Headers(init?.headers).get("x-headless-secret-key")).toBe(
      SECRET
    );
    expect(JSON.parse(String(init?.body))).toStrictEqual({
      values: submission.values,
    });
  });

  it("answers 413 when Content-Length is over the limit", async () => {
    const response = await POST(
      post(JSON.stringify(submission), {
        "content-length": String(MAX_BODY_BYTES + 1),
      })
    );

    expect(response.status).toBe(413);
    expect(transport.wordpressFetch).not.toHaveBeenCalled();
  });

  it("answers 413 when the body itself is over the limit", async () => {
    const values = { message: "x".repeat(MAX_BODY_BYTES) };
    const response = await POST(post(JSON.stringify({ formId: "7", values })));

    expect(response.status).toBe(413);
    expect(transport.wordpressFetch).not.toHaveBeenCalled();
  });

  it("counts the body's size in bytes, not characters", async () => {
    // Each "é" is two bytes in UTF-8, so this is under the limit in characters only.
    const values = { message: "é".repeat(MAX_BODY_BYTES / 2) };

    const response = await POST(post(JSON.stringify({ formId: "7", values })));

    expect(response.status).toBe(413);
  });

  it.each([
    ["malformed JSON", "{formId:"],
    [
      "a form ID that is not a number",
      JSON.stringify({ formId: "7a", values: {} }),
    ],
    [
      "values that are not strings",
      JSON.stringify({ formId: "7", values: { a: 1 } }),
    ],
  ])("answers 400 to %s", async (_, body) => {
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    expect(transport.wordpressFetch).not.toHaveBeenCalled();
  });

  it("answers 503 when no shared secret is set", async () => {
    vi.stubEnv("HEADLESS_SECRET", "");

    const response = await POST(post(JSON.stringify(submission)));

    expect(response.status).toBe(503);
    expect(transport.wordpressFetch).not.toHaveBeenCalled();
  });

  it.each([401, 403, 500, 503])(
    "answers WordPress's %i with a plain 502",
    async (status) => {
      transport.wordpressFetch.mockResolvedValue(
        answer({ message: "Internal detail from WordPress" }, status)
      );

      const response = await POST(post(JSON.stringify(submission)));

      expect(response.status).toBe(502);
      await expect(messageOf(response)).resolves.toBe(
        "The form could not be sent."
      );
    }
  );

  it("passes WordPress's message and status through for another 4xx", async () => {
    transport.wordpressFetch.mockResolvedValue(
      answer({ message: "email must be an email address." }, 422)
    );

    const response = await POST(post(JSON.stringify(submission)));

    expect(response.status).toBe(422);
    await expect(messageOf(response)).resolves.toBe(
      "email must be an email address."
    );
  });

  it("falls back to a generic message for a 4xx without one", async () => {
    transport.wordpressFetch.mockResolvedValue(
      new Response("not json", { status: 404 })
    );

    const response = await POST(post(JSON.stringify(submission)));

    expect(response.status).toBe(404);
    await expect(messageOf(response)).resolves.toBe("Submission rejected.");
  });
});
