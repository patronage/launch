import type { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_BODY_BYTES } from "@/lib/form-submission";

import { POST } from "./route";

const visitor = null;

interface FormDoc {
  fields: { blockType: string; name: string; required: boolean }[];
  id: number;
}

interface LocalApiArgs {
  collection: string;
  overrideAccess: boolean;
  user: null;
}

const payload = vi.hoisted(() => ({
  create: vi.fn<(args: LocalApiArgs) => Promise<{ id: number }>>(),
  findByID: vi.fn<(args: LocalApiArgs) => Promise<FormDoc>>(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking, vitest/prefer-import-in-mock -- a partial stand-in; stands in for Payload, so the test needs no database.
vi.mock("@/lib/payload", () => ({
  getFrontendPayload: () => Promise.resolve({ payload, user: visitor }),
}));

const form: FormDoc = {
  fields: [
    { blockType: "email", name: "email", required: true },
    { blockType: "textarea", name: "message", required: false },
  ],
  id: 7,
};

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  // SAFETY: the handler reads the request as a plain Request.
  new Request("https://site.example.org/forms/submit", {
    body,
    headers: { "content-type": "application/json", ...headers },
    method: "POST",
  }) as NextRequest;

const submit = (values: Record<string, string>) =>
  POST(post(JSON.stringify({ formId: "7", values })));

const messageOf = async (response: Response): Promise<string | undefined> => {
  // SAFETY: the route always answers JSON with an optional message.
  const body = (await response.json()) as { message?: string };

  return body.message;
};

describe("POST /forms/submit", () => {
  beforeEach(() => {
    payload.findByID.mockResolvedValue(form);
    payload.create.mockResolvedValue({ id: 1 });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("saves the form's own fields as a submission with the visitor's access", async () => {
    const response = await submit({
      email: " visitor@example.org ",
      message: "Hello",
      notAField: "dropped",
    });

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toStrictEqual({ ok: true });
    expect(payload.findByID).toHaveBeenCalledWith(
      expect.objectContaining({ id: "7", overrideAccess: false, user: visitor })
    );
    expect(payload.create).toHaveBeenCalledWith({
      collection: "form-submissions",
      data: {
        form: 7,
        submissionData: [
          { field: "email", value: "visitor@example.org" },
          { field: "message", value: "Hello" },
        ],
      },
      overrideAccess: false,
      user: visitor,
    });
  });

  it("answers 413 when Content-Length is over the limit", async () => {
    const response = await POST(
      post(JSON.stringify({ formId: "7", values: {} }), {
        "content-length": String(MAX_BODY_BYTES + 1),
      })
    );

    expect(response.status).toBe(413);
    expect(payload.findByID).not.toHaveBeenCalled();
  });

  it("answers 413 when the body itself is over the limit", async () => {
    const response = await submit({ message: "x".repeat(MAX_BODY_BYTES) });

    expect(response.status).toBe(413);
    expect(payload.create).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{formId:"],
    [
      "values that are not strings",
      JSON.stringify({ formId: "7", values: { email: 1 } }),
    ],
    ["no form ID", JSON.stringify({ values: {} })],
  ])("answers 400 to %s", async (_, body) => {
    const response = await POST(post(body));

    expect(response.status).toBe(400);
    expect(payload.findByID).not.toHaveBeenCalled();
  });

  it("answers 404 for a form the visitor cannot read", async () => {
    payload.findByID.mockRejectedValue(new Error("Not Found"));

    const response = await submit({ email: "visitor@example.org" });

    expect(response.status).toBe(404);
    expect(payload.create).not.toHaveBeenCalled();
  });

  it("answers 400 with the first problem when a value does not fit its field", async () => {
    const response = await submit({ email: "not-an-email" });

    expect(response.status).toBe(400);
    await expect(messageOf(response)).resolves.toBe(
      "email must be an email address."
    );
    expect(payload.create).not.toHaveBeenCalled();
  });

  it("answers 400 when a required field is missing", async () => {
    const response = await submit({ message: "Hello" });

    expect(response.status).toBe(400);
    await expect(messageOf(response)).resolves.toBe("email is required.");
  });
});
