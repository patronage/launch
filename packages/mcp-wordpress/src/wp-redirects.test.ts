import {
  ApplyConflictError,
  createUpstreamTelemetry,
} from "@patronage/mcp-core";
import type { OperationPreflight, UpstreamClient } from "@patronage/mcp-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { inspectWordPressResponse } from "./wordpress";
import { applyOperations, preflightOperations } from "./wp-apply";
import type { UpsertRedirectOperation } from "./wp-operations";

const client: UpstreamClient = {
  apiUrl: "https://wordpress.example",
  auth: { kind: "access-jwt", token: "caller-token" },
  inspect: inspectWordPressResponse,
  label: "WordPress",
};

const operation: UpsertRedirectOperation = {
  code: 301,
  kind: "upsert_redirect",
  source: "/old-page",
  target: "/new-page",
};

interface Rule {
  action_code: number;
  action_data: { url: string };
  action_type: string;
  enabled: boolean;
  group_id: number;
  id: number;
  match_type: string;
  regex: boolean;
  title: string;
  url: string;
}

const rule = (overrides: Partial<Rule> = {}): Rule => ({
  action_code: 301,
  action_data: { url: "/somewhere-else" },
  action_type: "url",
  enabled: true,
  group_id: 1,
  id: 9,
  match_type: "url",
  regex: false,
  title: "",
  url: "/old-page",
  ...overrides,
});

// What the connector sends Redirection when it creates or updates a rule.
const ruleBodySchema = z.strictObject({
  action_code: z.number(),
  action_data: z.object({ url: z.string() }),
  action_type: z.literal("url"),
  group_id: z.number(),
  match_type: z.literal("url"),
  regex: z.literal(false),
  title: z.string(),
  url: z.string(),
});

type RuleBody = z.infer<typeof ruleBodySchema>;

interface FakeRedirection {
  posts: { body: RuleBody; path: string }[];
  rules: Rule[];
}

// A small in-memory Redirection REST API: list with a substring filter, list
// groups, create, and update.
const stubRedirection = (initial: Rule[]): FakeRedirection => {
  const state: FakeRedirection = { posts: [], rules: [...initial] };

  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);

      if (url.pathname === "/wp-json/redirection/v1/group") {
        return Response.json({
          items: [
            { enabled: true, id: 4, module_id: 2 },
            { enabled: true, id: 1, module_id: 1 },
            { default: true, enabled: true, id: 6, module_id: 1 },
          ],
          total: 2,
        });
      }

      if (request.method === "POST") {
        const body = ruleBodySchema.parse(await request.json());

        state.posts.push({ body, path: url.pathname });
        const id = Number(url.pathname.split("/").at(-1));

        const next = rule({
          action_code: body.action_code,
          action_data: body.action_data,
          group_id: body.group_id,
          id: Number.isNaN(id) ? 50 : id,
          url: body.url,
        });

        state.rules = [...state.rules.filter((r) => r.id !== next.id), next];

        return Response.json({ items: state.rules, total: state.rules.length });
      }

      const filter = url.searchParams.get("filterBy[url]") ?? "";
      const items = state.rules.filter((r) => r.url.includes(filter));

      return Response.json({ items, total: items.length });
    }
  );

  return state;
};

const preflight = async () =>
  await preflightOperations(
    client,
    "Fix a broken link",
    [operation],
    createUpstreamTelemetry()
  );

const apply = async (snapshot: OperationPreflight) =>
  await applyOperations({
    approverOpaque: "approver00000000",
    client,
    executionId: "exec_1",
    operations: [operation],
    preflight: { intent: "Fix a broken link", operations: [snapshot] },
    requesterOpaque: "requester0000000",
    telemetry: createUpstreamTelemetry(),
  });

describe("upsert_redirect", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("previews and creates a new rule in the default WordPress group", async () => {
    const fake = stubRedirection([rule({ id: 2, url: "/old-page-two" })]);

    const preview = await preflight();
    const [snapshot] = preview.operations;

    expect(snapshot).toMatchObject({
      editUrl:
        "https://wordpress.example/wp-admin/tools.php?page=redirection.php",
      editor: "Redirection",
      fields: [
        { after: "/new-page", before: "", changed: true, path: "target" },
        { after: "301", before: "", changed: true, path: "code" },
      ],
      target: "redirect /old-page",
    });

    if (!snapshot) {
      return;
    }

    const receipt = await apply(snapshot);

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["target", "code"],
      kind: "upsert_redirect",
      status: "changed",
    });
    expect(fake.posts).toStrictEqual([
      {
        body: {
          action_code: 301,
          action_data: { url: "/new-page" },
          action_type: "url",
          group_id: 6,
          match_type: "url",
          regex: false,
          title: "",
          url: "/old-page",
        },
        path: "/wp-json/redirection/v1/redirect",
      },
    ]);
  });

  it("updates the existing rule in place and keeps its group and title", async () => {
    const fake = stubRedirection([
      rule({ group_id: 3, title: "Old campaign" }),
    ]);

    const preview = await preflight();
    const [snapshot] = preview.operations;

    expect(snapshot?.fields).toStrictEqual([
      {
        after: "/new-page",
        before: "/somewhere-else",
        changed: true,
        path: "target",
      },
      { after: "301", before: "301", changed: false, path: "code" },
    ]);

    if (!snapshot) {
      return;
    }

    const receipt = await apply(snapshot);

    expect(receipt.operations[0]).toMatchObject({
      changed_paths: ["target"],
      status: "changed",
    });
    expect(fake.posts[0]).toMatchObject({
      body: { group_id: 3, title: "Old campaign" },
      path: "/wp-json/redirection/v1/redirect/9",
    });
  });

  it("writes nothing when the rule already matches", async () => {
    const fake = stubRedirection([rule({ action_data: { url: "/new-page" } })]);

    const preview = await preflight();
    const [snapshot] = preview.operations;

    if (!snapshot) {
      return;
    }

    const receipt = await apply(snapshot);

    expect(receipt.operations[0]).toMatchObject({ status: "unchanged" });
    expect(fake.posts).toStrictEqual([]);
  });

  it("refuses to write when the rule changed after the preview", async () => {
    const fake = stubRedirection([]);

    const preview = await preflight();
    const [snapshot] = preview.operations;
    fake.rules.push(rule({ action_data: { url: "/someone-else" } }));

    if (!snapshot) {
      return;
    }

    const receipt = await apply(snapshot);

    expect(receipt.operations[0]).toMatchObject({
      error: { code: "modified_since_preflight" },
      status: "conflict",
    });
    expect(fake.posts).toStrictEqual([]);
  });

  it("ignores regex rules and refuses ambiguous or disabled exact rules", async () => {
    stubRedirection([rule({ regex: true, url: "/old-page" })]);
    const regexPreview = await preflight();
    const [created] = regexPreview.operations;
    expect(created?.fields[0]).toMatchObject({ before: "" });

    vi.unstubAllGlobals();
    stubRedirection([rule({ id: 1 }), rule({ id: 2 })]);
    await expect(preflight()).rejects.toMatchObject({
      code: "ambiguous_redirect",
    });

    vi.unstubAllGlobals();
    stubRedirection([rule({ enabled: false })]);
    await expect(preflight()).rejects.toMatchObject({
      code: "redirect_disabled",
    });
  });

  it("reports a site without Redirection plainly", async () => {
    vi.stubGlobal("fetch", () =>
      Response.json(
        { code: "rest_no_route", message: "No route" },
        { status: 404 }
      )
    );

    const failure = preflight();

    await expect(failure).rejects.toBeInstanceOf(ApplyConflictError);
    await expect(failure).rejects.toMatchObject({
      code: "redirection_unavailable",
    });
  });
});
