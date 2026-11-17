import type {
  OperationPreflight,
  OperationReceipt,
  UpstreamClient,
  UpstreamTelemetry,
} from "@patronage/mcp-core";
import { z } from "zod";

import { payloadRest } from "./payload";
import { documentPath, globalPath } from "./payload-documents";
import { hasStatusPerLocale } from "./payload-locale";
import type { LocaleScope } from "./payload-locale";
import { STATUS_FIELD } from "./payload-operations";
import type { PayloadOperation } from "./payload-operations";

// `publish_all_locales` writes the status of every locale, and an operation
// reads its target in one. So what the write is about to do to the others,
// and whether it did, is read apart: the document itself with `locale=all`,
// which answers `_status` as one value for each locale.

const statusesSchema = z.object({
  [STATUS_FIELD]: z.record(z.string(), z.string()),
});

const EVERY_STATUS = `&locale=all&select[${STATUS_FIELD}]=true`;

const publishesEveryLocale = (operation: PayloadOperation): boolean =>
  "publish_all_locales" in operation &&
  operation.publish_all_locales === true &&
  operation.publish === true;

// Where the statuses of the operation's target are read from: the document
// or global itself, not its newest version, whose statuses are not what the
// public is served.
const statusesPath = (operation: PayloadOperation): string | undefined => {
  if (!publishesEveryLocale(operation)) {
    return undefined;
  }

  if ("global" in operation) {
    return `${globalPath(operation.global, false)}${EVERY_STATUS}`;
  }

  return "id" in operation
    ? `${documentPath(operation.collection, operation.id, false)}${EVERY_STATUS}`
    : undefined;
};

/** Each locale's status, by locale code in order. */
export type LocaleStatuses = [code: string, status: string][];

/**
 * The status of every locale of an operation's target, for an operation
 * that publishes them all on a target that keeps one for each. Undefined
 * for any other operation, and when Payload does not answer with them.
 * `client` is one that is not bound to a locale.
 */
export const readLocaleStatuses = async (
  client: UpstreamClient,
  operation: PayloadOperation,
  scope: LocaleScope | undefined,
  telemetry: UpstreamTelemetry
): Promise<LocaleStatuses | undefined> => {
  const path = statusesPath(operation);

  if (path === undefined || !scope || !hasStatusPerLocale(scope)) {
    return undefined;
  }

  try {
    const result = await payloadRest(client, path, telemetry);
    const parsed = statusesSchema.safeParse(result.json);

    return result.status === 200 && parsed.success
      ? Object.entries(parsed.data[STATUS_FIELD]).toSorted(([a], [b]) =>
          a.localeCompare(b)
        )
      : undefined;
  } catch {
    // The preview and the receipt then say what one locale shows.
    return undefined;
  }
};

const unpublished = (statuses: LocaleStatuses): string[] =>
  statuses.filter(([, status]) => status !== "published").map(([code]) => code);

/**
 * The preview of an operation that publishes every locale, with its
 * `_status` row saying where each locale stands now: the operation's own
 * locale may be published already while another is not.
 */
export const withLocaleStatuses = (
  preview: OperationPreflight,
  statuses: LocaleStatuses | undefined
): OperationPreflight =>
  statuses === undefined
    ? preview
    : {
        ...preview,
        fields: preview.fields.map((field) =>
          field.path === STATUS_FIELD
            ? {
                ...field,
                before: statuses
                  .map(([code, status]) => `${code}: ${status}`)
                  .join(", "),
                changed: unpublished(statuses).length > 0,
              }
            : field
        ),
      };

/**
 * The receipt of a write that was to publish every locale, checked against
 * all of them: a locale that is still a draft fails it, and one that was a
 * draft before counts as a change even where the operation's own locale
 * was published already.
 */
export const confirmEveryLocale = (
  receipt: OperationReceipt,
  before: LocaleStatuses | undefined,
  after: LocaleStatuses | undefined
): OperationReceipt => {
  const landed = receipt.status === "changed" || receipt.status === "unchanged";

  if (!landed || before === undefined || after === undefined) {
    return receipt;
  }

  const left = unpublished(after);

  if (left.length > 0) {
    return {
      ...receipt,
      error: {
        code: "not_published",
        message: `Payload saved ${receipt.target} but did not publish it in ${left.join(", ")}`,
      },
      status: "failed",
    };
  }

  return unpublished(before).length > 0 &&
    !receipt.changed_paths.includes(STATUS_FIELD)
    ? {
        ...receipt,
        changed_paths: [...receipt.changed_paths, STATUS_FIELD],
        status: "changed",
      }
    : receipt;
};
