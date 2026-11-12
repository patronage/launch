import { describe, expect, it } from "vitest";

import {
  MAX_BODY_BYTES,
  MAX_VALUE_LENGTH,
  parseSubmission,
  readBody,
  submissionData,
} from "./form-submission";
import type { FormFieldBlock } from "./form-submission";

const fields: FormFieldBlock[] = [
  { blockType: "text", name: "name", required: true },
  { blockType: "email", name: "email", required: true },
  { blockType: "number", name: "guests" },
  {
    blockType: "select",
    name: "topic",
    options: [
      { label: "Press", value: "press" },
      { label: "Support", value: "support" },
    ],
  },
  { blockType: "checkbox", name: "terms", required: true },
  { blockType: "checkbox", name: "updates" },
  { blockType: "message" },
];

const valid = {
  email: "reader@example.com",
  name: "Reader",
  terms: "true",
};

const submit = (values: Record<string, string>) =>
  submissionData(fields, new Map(Object.entries(values)));

describe(submissionData, () => {
  it("keeps the form's own filled-in fields, trimmed, in form order", () => {
    expect(
      submit({
        ...valid,
        guests: "3",
        name: "  Reader  ",
        topic: "press",
      })
    ).toStrictEqual({
      data: [
        { field: "name", value: "Reader" },
        { field: "email", value: "reader@example.com" },
        { field: "guests", value: "3" },
        { field: "topic", value: "press" },
        { field: "terms", value: "true" },
      ],
    });
  });

  it("drops values for fields the form does not have", () => {
    expect(submit({ ...valid, isAdmin: "true", role: "admin" })).toStrictEqual(
      submit(valid)
    );
  });

  it("leaves out empty optional fields", () => {
    expect(submit({ ...valid, guests: "", topic: "  " })).toStrictEqual(
      submit(valid)
    );
  });

  it.each([
    ["a missing required field", { ...valid, name: "" }, "name is required."],
    ["a blank required field", { ...valid, name: "   " }, "name is required."],
    [
      "an unticked required checkbox",
      { ...valid, terms: "false" },
      "terms is required.",
    ],
    [
      "an email that is not an address",
      { ...valid, email: "reader" },
      "email must be an email address.",
    ],
    [
      "a number that is not a number",
      { ...valid, guests: "three" },
      "guests must be a number.",
    ],
    [
      "a select value not among its options",
      { ...valid, topic: "billing" },
      "topic must be one of its options.",
    ],
    [
      "a checkbox that is not true or false",
      { ...valid, updates: "yes" },
      "updates must be true or false.",
    ],
  ])("refuses %s", (_name, values, problem) => {
    expect(submit(values)).toStrictEqual({ problem });
  });

  it("reads nothing for a field named like an Object.prototype key", () => {
    const result = submissionData(
      [{ blockType: "text", name: "constructor", required: true }],
      new Map()
    );

    expect(result).toStrictEqual({ problem: "constructor is required." });
  });
});

describe(parseSubmission, () => {
  it("accepts a form id and string values", () => {
    const parsed = parseSubmission(
      JSON.stringify({ formId: "1", values: { name: "Reader" } })
    );

    expect(parsed.data).toStrictEqual({
      formId: "1",
      values: { name: "Reader" },
    });
  });

  it("cuts every value to the longest kept length", () => {
    const parsed = parseSubmission(
      JSON.stringify({
        formId: "1",
        values: { name: "x".repeat(MAX_VALUE_LENGTH + 10) },
      })
    );

    expect(parsed.data?.values.name).toHaveLength(MAX_VALUE_LENGTH);
  });

  it.each([
    ["malformed JSON", "{"],
    ["a missing form id", JSON.stringify({ values: {} })],
    ["a non-string value", JSON.stringify({ formId: "1", values: { a: 1 } })],
    ["no body", ""],
  ])("refuses %s", (_name, body) => {
    expect(parseSubmission(body).success).toBeFalsy();
  });
});

const post = (body: BodyInit | null, headers: HeadersInit = {}) =>
  new Request("https://site.example/forms/submit", {
    body,
    headers,
    method: "POST",
  });

// A body sent in chunks with no Content-Length, as a client streaming it would.
const streamed = (chunks: number, chunkBytes: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let index = 0; index < chunks; index += 1) {
        controller.enqueue(new Uint8Array(chunkBytes).fill(97));
      }

      controller.close();
    },
  });

describe(readBody, () => {
  it("reads a body within the limit", async () => {
    await expect(readBody(post('{"formId":"1"}'))).resolves.toBe(
      '{"formId":"1"}'
    );
  });

  it("reads a body sent without Content-Length in chunks", async () => {
    const request = new Request("https://site.example/forms/submit", {
      body: streamed(4, 1024),
      // @ts-expect-error -- `duplex` is required by Node for a stream body but missing from RequestInit.
      duplex: "half",
      method: "POST",
    });

    await expect(readBody(request)).resolves.toHaveLength(4096);
  });

  it("reads an empty body as empty", async () => {
    await expect(readBody(post(null))).resolves.toBe("");
  });

  it("refuses a body whose Content-Length is over the limit without reading it", async () => {
    const request = post("{}", {
      "content-length": String(MAX_BODY_BYTES + 1),
    });

    await expect(readBody(request)).resolves.toBeUndefined();
    expect(request.bodyUsed).toBeFalsy();
  });

  it("stops reading a streamed body once it passes the limit", async () => {
    const chunkBytes = 16 * 1024;

    const request = new Request("https://site.example/forms/submit", {
      body: streamed(MAX_BODY_BYTES / chunkBytes + 2, chunkBytes),
      // @ts-expect-error -- `duplex` is required by Node for a stream body but missing from RequestInit.
      duplex: "half",
      method: "POST",
    });

    await expect(readBody(request)).resolves.toBeUndefined();
  });
});
