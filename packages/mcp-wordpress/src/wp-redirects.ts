import {
  ApplyConflictError,
  deepEqual,
  previewValue,
} from "@patronage/mcp-core";
import type {
  JsonObject,
  JsonValue,
  OperationPreflight,
  OperationReceipt,
  ReceiptError,
  UpstreamClient,
  UpstreamFetchResult,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { wordPressErrorMessage, wpFetch } from "./wordpress";
import {
  REDIRECT_PATHS,
  operationSentence,
  operationTarget,
} from "./wp-operations";
import type { UpsertRedirectOperation } from "./wp-operations";
import { missedPathsMessage, toReceiptError } from "./wp-receipts";

// Redirection's own REST API. Its routes check `redirection_role`
// (`manage_options` unless the site filters it), so the signed-in editor needs
// that capability; WordPress answers anyone else with a 403.
const REDIRECTS_PATH = "/wp-json/redirection/v1/redirect";
const GROUPS_PATH = "/wp-json/redirection/v1/group";

// Redirection's module id for rules WordPress itself serves (as opposed to
// rules it exports to Apache or Nginx config).
const WORDPRESS_MODULE = 1;

// Redirection caps `per_page` at 200. A source is filtered with a substring
// search, so a short source on a big site can match many rules; ten pages is
// well past any real collision and keeps a preview bounded.
const PAGE_SIZE = 200;
const MAX_PAGES = 10;

const REDIRECTION_EDITOR = "Redirection";

const redirectItemSchema = z.object({
  action_code: z.coerce.number().int(),
  action_data: z.unknown().optional(),
  action_type: z.string().optional(),
  enabled: z.boolean().optional(),
  group_id: z.coerce.number().int(),
  id: z.coerce.number().int().positive(),
  match_type: z.string().optional(),
  regex: z.coerce.boolean().optional(),
  status: z.string().optional(),
  title: z.string().nullish(),
  url: z.string(),
});

type RedirectItem = z.infer<typeof redirectItemSchema>;

const listSchema = z.object({
  items: z.array(z.unknown()),
  total: z.coerce.number().int().nonnegative().optional(),
});

const actionUrlSchema = z.object({ url: z.string() });

const groupSchema = z.object({
  default: z.boolean().optional(),
  enabled: z.boolean().optional(),
  id: z.coerce.number().int().positive(),
  module_id: z.coerce.number().int(),
});

interface ExistingRule {
  code: number;
  enabled: boolean;
  groupId: number;
  id: number;
  target: string | null;
  title: string;
}

const isEnabled = (item: RedirectItem): boolean =>
  item.enabled ?? item.status !== "disabled";

const actionUrl = (item: RedirectItem): string | null => {
  const parsed = actionUrlSchema.safeParse(item.action_data);

  return parsed.success ? parsed.data.url : null;
};

const toRule = (item: RedirectItem): ExistingRule => ({
  code: item.action_code,
  enabled: isEnabled(item),
  groupId: item.group_id,
  id: item.id,
  target: actionUrl(item),
  title: item.title ?? "",
});

const redirectionError = (
  result: UpstreamFetchResult,
  fallback: string
): ApplyConflictError => {
  if (result.status === 404 && result.errorCode === "rest_no_route") {
    return new ApplyConflictError(
      "redirection_unavailable",
      "The Redirection plugin's REST API is not available on this site"
    );
  }

  return new ApplyConflictError(
    result.errorCode ?? "read_failed",
    wordPressErrorMessage(result.status, result.errorCode) ?? fallback
  );
};

const listPath = (base: string, query: Record<string, string>): string =>
  `${base}?${new URLSearchParams(query).toString()}`;

const readPage = async (
  client: UpstreamClient,
  source: string,
  page: number,
  telemetry: UpstreamTelemetry
): Promise<{ items: RedirectItem[]; more: boolean }> => {
  const result = await wpFetch(
    client,
    listPath(REDIRECTS_PATH, {
      "filterBy[url]": source,
      page: String(page),
      per_page: String(PAGE_SIZE),
    }),
    telemetry
  );

  const parsed = listSchema.safeParse(result.json);

  if (result.status < 200 || result.status >= 300 || !parsed.success) {
    throw redirectionError(result, "Could not read Redirection rules");
  }

  const items = parsed.data.items.flatMap((item) => {
    const rule = redirectItemSchema.safeParse(item);

    return rule.success ? [rule.data] : [];
  });

  const seen = (page + 1) * PAGE_SIZE;

  const more =
    parsed.data.items.length === PAGE_SIZE &&
    (parsed.data.total === undefined || seen < parsed.data.total);

  return { items, more };
};

const collectPages = async (
  client: UpstreamClient,
  source: string,
  telemetry: UpstreamTelemetry,
  page: number,
  collected: RedirectItem[]
): Promise<RedirectItem[]> => {
  const { items, more } = await readPage(client, source, page, telemetry);

  collected.push(...items);

  if (!more) {
    return collected;
  }

  if (page + 1 >= MAX_PAGES) {
    throw new ApplyConflictError(
      "too_many_redirect_matches",
      `Too many Redirection rules contain ${source} to check it safely`
    );
  }

  return collectPages(client, source, telemetry, page + 1, collected);
};

// The one rule this operation owns: same source, plain URL match, no regex.
// A regex rule or another match type that happens to cover the path is left
// alone, because rewriting it would change more than this source.
const findRule = async (
  client: UpstreamClient,
  source: string,
  telemetry: UpstreamTelemetry
): Promise<ExistingRule | undefined> => {
  // Redirection pages from 0.
  const items = await collectPages(client, source, telemetry, 0, []);

  const exact = items.filter(
    (item) =>
      item.url === source &&
      item.regex !== true &&
      (item.match_type ?? "url") === "url" &&
      (item.action_type ?? "url") === "url"
  );

  if (exact.length > 1) {
    throw new ApplyConflictError(
      "ambiguous_redirect",
      `Redirection has ${exact.length} rules for ${source}; merge them in Redirection first`
    );
  }

  const [only] = exact;

  return only === undefined ? undefined : toRule(only);
};

// New rules go in the group Redirection marks as its default, or else the
// first enabled group WordPress serves ("Redirections" on a standard install).
const defaultGroup = async (
  client: UpstreamClient,
  telemetry: UpstreamTelemetry
): Promise<number> => {
  const result = await wpFetch(
    client,
    listPath(GROUPS_PATH, { per_page: String(PAGE_SIZE) }),
    telemetry
  );

  const parsed = listSchema.safeParse(result.json);

  if (result.status < 200 || result.status >= 300 || !parsed.success) {
    throw redirectionError(result, "Could not read Redirection groups");
  }

  const usable = parsed.data.items.flatMap((item) => {
    const group = groupSchema.safeParse(item);

    return group.success &&
      group.data.module_id === WORDPRESS_MODULE &&
      group.data.enabled !== false
      ? [group.data]
      : [];
  });

  const chosen = usable.find((group) => group.default === true) ?? usable[0];

  if (chosen === undefined) {
    throw new ApplyConflictError(
      "no_redirect_group",
      "Redirection has no enabled WordPress group to add the rule to"
    );
  }

  return chosen.id;
};

// The preview's revision stamp: the rule this operation would touch, or its
// absence. Apply re-reads the rule and refuses to write when this differs, the
// same gate `modified_gmt` gives a post.
const ruleStamp = (rule: ExistingRule | undefined): string =>
  rule === undefined
    ? "redirect:none"
    : `redirect:${JSON.stringify([rule.id, rule.target, rule.code, rule.enabled])}`;

const ruleValue = (
  rule: ExistingRule | undefined,
  path: string
): JsonValue | null => {
  if (rule === undefined) {
    return null;
  }

  return path === "code" ? rule.code : rule.target;
};

const requestedRuleValue = (
  operation: UpsertRedirectOperation,
  path: string
): JsonValue => (path === "code" ? operation.code : operation.target);

export const redirectionAdminUrl = (apiUrl: string): string =>
  new URL("/wp-admin/tools.php?page=redirection.php", apiUrl).toString();

const assertWritable = (
  operation: UpsertRedirectOperation,
  rule: ExistingRule | undefined
): void => {
  // Updating a disabled rule would not turn it back on, so the approver would
  // see a change that never takes effect.
  if (rule !== undefined && !rule.enabled) {
    throw new ApplyConflictError(
      "redirect_disabled",
      `The Redirection rule for ${operation.source} is disabled; enable or delete it in Redirection first`
    );
  }
};

export const preflightRedirect = async (
  client: UpstreamClient,
  operation: UpsertRedirectOperation,
  telemetry: UpstreamTelemetry,
  index: number
): Promise<OperationPreflight> => {
  const rule = await findRule(client, operation.source, telemetry);

  assertWritable(operation, rule);

  if (rule === undefined) {
    // Proves a group exists before anyone approves a rule that could not be
    // created; apply looks it up again.
    await defaultGroup(client, telemetry);
  }

  return {
    editUrl: redirectionAdminUrl(client.apiUrl),
    editor: REDIRECTION_EDITOR,
    fields: REDIRECT_PATHS.map((path) => {
      const before = ruleValue(rule, path);
      const after = requestedRuleValue(operation, path);

      return {
        after: previewValue(after),
        before: previewValue(before),
        changed: !deepEqual(before, after),
        path,
      };
    }),
    modifiedGmt: ruleStamp(rule),
    operationIndex: index,
    sentence: operationSentence(operation),
    slug: operation.source,
    target: operationTarget(operation),
  };
};

const ruleBody = (
  operation: UpsertRedirectOperation,
  groupId: number,
  title: string
): JsonObject => ({
  action_code: operation.code,
  action_data: { url: operation.target },
  action_type: "url",
  group_id: groupId,
  match_type: "url",
  regex: false,
  title,
  url: operation.source,
});

const writeRule = async (
  client: UpstreamClient,
  operation: UpsertRedirectOperation,
  rule: ExistingRule | undefined,
  telemetry: UpstreamTelemetry
): Promise<UpstreamFetchResult> => {
  const body =
    rule === undefined
      ? ruleBody(operation, await defaultGroup(client, telemetry), "")
      : ruleBody(operation, rule.groupId, rule.title);

  return await wpFetch(
    client,
    rule === undefined ? REDIRECTS_PATH : `${REDIRECTS_PATH}/${rule.id}`,
    telemetry,
    {
      body: JSON.stringify(body),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }
  );
};

export const applyRedirect = async (
  client: UpstreamClient,
  operation: UpsertRedirectOperation,
  snapshot: OperationPreflight,
  telemetry: UpstreamTelemetry
): Promise<OperationReceipt> => {
  const target = operationTarget(operation);

  const result = (
    status: OperationReceipt["status"],
    changed: string[],
    error?: ReceiptError
  ): OperationReceipt => {
    const receipt: OperationReceipt = {
      changed_paths: changed,
      kind: operation.kind,
      normalized_paths: [],
      operation_index: snapshot.operationIndex,
      status,
      target,
    };

    if (error !== undefined) {
      receipt.error = error;
    }

    return receipt;
  };

  if (snapshot.target !== target) {
    return result("failed", [], {
      code: "preflight_mismatch",
      message: "The approval preview describes a different target",
    });
  }

  let before: ExistingRule | undefined;

  try {
    before = await findRule(client, operation.source, telemetry);
  } catch (error) {
    return result("failed", [], toReceiptError(error));
  }

  if (ruleStamp(before) !== snapshot.modifiedGmt) {
    return result("conflict", [], {
      code: "modified_since_preflight",
      message: `${target} changed after the approval preview`,
    });
  }

  const changed = REDIRECT_PATHS.filter(
    (path) =>
      !deepEqual(ruleValue(before, path), requestedRuleValue(operation, path))
  );

  if (changed.length === 0) {
    return result("unchanged", []);
  }

  let write: UpstreamFetchResult;

  try {
    write = await writeRule(client, operation, before, telemetry);
  } catch (error) {
    return result("failed", [], toReceiptError(error));
  }

  if (write.status < 200 || write.status >= 300) {
    return result("failed", [], {
      code: write.errorCode ?? "write_failed",
      message:
        wordPressErrorMessage(write.status, write.errorCode) ??
        `Redirection rejected the rule for ${operation.source}`,
    });
  }

  let after: ExistingRule | undefined;

  try {
    after = await findRule(client, operation.source, telemetry);
  } catch (error) {
    return result("failed", [], toReceiptError(error));
  }

  const missed = changed.filter(
    (path) =>
      !deepEqual(ruleValue(after, path), requestedRuleValue(operation, path))
  );

  if (missed.length > 0) {
    return result(
      "failed",
      changed.filter((path) => !missed.includes(path)),
      { code: "readback_mismatch", message: missedPathsMessage(missed) }
    );
  }

  return result("changed", changed);
};
