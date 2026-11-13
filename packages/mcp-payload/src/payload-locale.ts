import { ApplyConflictError, deepEqual } from "@patronage/mcp-core";
import type {
  FieldSnapshot,
  JsonObject,
  JsonValue,
  OperationPreflight,
} from "@patronage/mcp-core";
import { z } from "zod";

import type { EditingInfo, RowsField } from "./payload-editing";
import { inLocaleSentence, STATUS_FIELD } from "./payload-operations";
import type { PayloadOperation } from "./payload-operations";

// Writing one locale of a site that keeps its content in several.
//
// Payload stores a localized field once for each locale and every other
// field once for all of them. A request names the locale it reads or writes
// with `?locale=`; without one it means the site's default locale. So an
// operation that names a `locale` changes that locale's value of each
// localized field, and the one shared value of every other field.
//
// Where a collection or global with drafts has a localized field, Payload
// keeps `_status` for each locale too, so publishing is by locale: the
// operation's, or all of them with `publish_all_locales`. A publish of one
// locale still puts the newest draft's shared fields live for every locale.

/** One locale of a site, and what the operation's target keeps for each. */
export interface LocaleScope {
  /** The locale the operation reads and writes. */
  code: string;
  /**
   * The target's localized fields outside any row, by path. A field under
   * one of them is localized with it.
   */
  localizedFields: string[];
  /** False when the operation named none, and so means the default. */
  named: boolean;
}

/** The locale an operation names, for the kinds that write one locale. */
export const namedLocale = (operation: PayloadOperation): string | undefined =>
  "locale" in operation ? operation.locale : undefined;

interface Target {
  localized: boolean;
  localizedFields?: string[] | undefined;
  slug: string;
}

const targetOf = (
  info: EditingInfo,
  operation: PayloadOperation
): Target | undefined => {
  if ("global" in operation) {
    return info.globals.find((entry) => entry.slug === operation.global);
  }

  return info.collections.find((entry) => entry.slug === operation.collection);
};

// Restoring a version and the trash are about the whole document, every
// locale of it, and take no `locale`.
const WHOLE_DOCUMENT = new Set<PayloadOperation["kind"]>([
  "restore_from_trash",
  "restore_global_version",
  "restore_version",
  "trash",
]);

/**
 * The locale an operation works in, or undefined where there is none to
 * speak of: a site without locales, a target with no localized field, or a
 * kind that is about the whole document. Throws for a `locale` that cannot
 * be honoured, since Payload itself would quietly write the default locale
 * instead.
 */
export const localeScope = (
  info: EditingInfo,
  operation: PayloadOperation
): LocaleScope | undefined => {
  if (WHOLE_DOCUMENT.has(operation.kind)) {
    return undefined;
  }

  const named = namedLocale(operation);
  const target = targetOf(info, operation);

  // An unpublish that names no locale takes the whole document off the
  // site, every locale of it, and says so itself.
  if (operation.kind === "unpublish" && named === undefined) {
    return undefined;
  }

  if (!info.localization) {
    if (named !== undefined) {
      throw new ApplyConflictError(
        "not_localized",
        "This site has no locales, so an operation cannot name one"
      );
    }

    return undefined;
  }

  // A target Payload does not describe is refused by its own operation.
  if (!target) {
    return undefined;
  }

  if (!target.localized) {
    if (named !== undefined) {
      throw new ApplyConflictError(
        "not_localized",
        `${target.slug} has no localized fields: everything in it is shared by every locale, so leave locale out`
      );
    }

    return undefined;
  }

  const { defaultLocale, locales } = info.localization;

  if (named !== undefined && !locales.includes(named)) {
    throw new ApplyConflictError(
      "unknown_locale",
      `This site has no ${named} locale. It has: ${locales.join(", ")}`
    );
  }

  // An older `getEditingInfo` says a target is localized but not which
  // fields are. A write in the default locale goes on as it always has;
  // one that names a locale needs to show what it shares with the others.
  if (target.localizedFields === undefined) {
    if (named !== undefined) {
      throw new ApplyConflictError(
        "localized_fields_unknown",
        "This site's getEditingInfo does not list localized fields, so an approval could not show which fields a locale shares with the others. Update the site's Payload MCP tools"
      );
    }

    return undefined;
  }

  // Where the target keeps one status for all locales, Payload would take
  // the whole document off the site, whatever locale the request is in.
  if (
    operation.kind === "unpublish" &&
    !target.localizedFields.includes(STATUS_FIELD)
  ) {
    throw new ApplyConflictError(
      "status_not_per_locale",
      `${target.slug} keeps one status for every locale, so one locale cannot be unpublished alone; leave locale out to unpublish the document`
    );
  }

  return {
    code: named ?? defaultLocale,
    localizedFields: target.localizedFields,
    named: named !== undefined,
  };
};

const publishesAll = (operation: PayloadOperation): boolean =>
  "publish_all_locales" in operation && operation.publish_all_locales === true;

const publishes = (operation: PayloadOperation): boolean =>
  "publish" in operation && operation.publish === true;

/**
 * What a publishing write adds to its path to publish every locale. Payload
 * otherwise publishes the request's locale alone, where the target keeps a
 * status for each.
 */
export const publishLocalesQuery = (operation: PayloadOperation): string =>
  publishes(operation) && publishesAll(operation)
    ? "&publishAllLocales=true"
    : "";

/** Whether `path`, or a field above it, is in `localizedFields`. */
export const isLocalizedPath = (
  localizedFields: string[],
  path: string
): boolean =>
  localizedFields.some(
    (field) => path === field || path.startsWith(`${field}.`)
  );

// What `getEditingInfo` says a document, or one row of it, keeps for each
// locale, and which of its fields hold rows.
interface SharedContext {
  localizedFields?: string[] | undefined;
  rowFields?: RowsField[] | undefined;
}

const recordSchema = z.record(z.string(), z.json());
const blockTypeSchema = z.object({ blockType: z.string() });

// The fields a row of `field` holds: an array's own, or those of the row's
// block type.
const rowContext = (field: RowsField, row: JsonValue): SharedContext => {
  if (field.type === "array") {
    return field;
  }

  const type = blockTypeSchema.safeParse(row);

  return (
    (type.success &&
      field.blocks?.find((block) => block.slug === type.data.blockType)) ||
    {}
  );
};

// A value with everything Payload keeps for each locale taken out of it,
// rows included, so what is left is what every locale shares.
const sharedPart = (
  value: JsonValue | undefined,
  path: string,
  context: SharedContext
): JsonValue => {
  const rows = context.rowFields?.find((field) => field.path === path);

  if (rows && Array.isArray(value)) {
    return value.map((row) => sharedPart(row, "", rowContext(rows, row)));
  }

  const record = Array.isArray(value)
    ? undefined
    : recordSchema.safeParse(value).data;

  if (!record) {
    return value ?? null;
  }

  return Object.fromEntries(
    Object.entries(record)
      .map(([key, child]): [string, JsonValue | undefined] => [
        path ? `${path}.${key}` : key,
        child,
      ])
      .filter(
        ([childPath]) =>
          !isLocalizedPath(context.localizedFields ?? [], childPath)
      )
      .map(([childPath, child]) => [
        childPath,
        sharedPart(child, childPath, context),
      ])
  );
};

// Fields Payload keeps itself, which say nothing about content.
const SYSTEM_FIELDS = new Set([
  "createdAt",
  "deletedAt",
  "id",
  STATUS_FIELD,
  "updatedAt",
]);

/**
 * The top-level fields in which a document's newest draft differs from what
 * is published, counting only what every locale shares. Payload holds those
 * once for a draft, and puts them live for every published locale whenever
 * one locale's status is written: a publish, and an unpublish too.
 *
 * Both records are read in the same locale, so a localized field differs
 * only in that locale's own value, which is left out.
 */
export const sharedDraftChanges = (
  target: SharedContext,
  published: JsonObject,
  draft: JsonObject
): string[] =>
  Object.keys({ ...published, ...draft })
    .filter(
      (key) =>
        !SYSTEM_FIELDS.has(key) &&
        !isLocalizedPath(target.localizedFields ?? [], key)
    )
    .filter(
      (key) =>
        !deepEqual(
          sharedPart(published[key], key, target),
          sharedPart(draft[key], key, target)
        )
    )
    .toSorted();

/** Whether the target keeps `_status` for each locale. */
export const hasStatusPerLocale = (scope: LocaleScope): boolean =>
  scope.localizedFields.includes(STATUS_FIELD);

const EVERY_LOCALE = "every locale";

/** A field's label with who it changes for: one locale, or all of them. */
export const scopeLabel = (
  code: string,
  label: string,
  perLocale: boolean
): string => `${label} · ${perLocale ? `${code} only` : EVERY_LOCALE}`;

// Row changes carry a `[` in their path and are labelled by the row
// engine, which knows what each row's fields are.
const isRowPath = (path: string): boolean => path.includes("[");

const scopedField = (
  scope: LocaleScope,
  operation: PayloadOperation,
  field: FieldSnapshot
): FieldSnapshot => {
  if (isRowPath(field.path)) {
    return field;
  }

  const perLocale =
    field.path === STATUS_FIELD && publishesAll(operation)
      ? false
      : isLocalizedPath(scope.localizedFields, field.path);

  return {
    ...field,
    label: scopeLabel(scope.code, field.label ?? field.path, perLocale),
  };
};

const publishWarning = (
  scope: LocaleScope,
  operation: PayloadOperation
): string => {
  if (!(publishes(operation) && hasStatusPerLocale(scope))) {
    return "";
  }

  return publishesAll(operation)
    ? `This publishes every locale, each with what its newest draft holds. Only the ${scope.code} locale is shown here.`
    : `This publishes the ${scope.code} locale only. Fields marked “${EVERY_LOCALE}” go live for all locales, along with shared changes saved in earlier drafts.`;
};

/**
 * An approval preview that says which locale it is about: in its sentence,
 * on each field (one locale's value, or the value every locale shares) and,
 * where it publishes, in a warning about what goes live for whom.
 */
export const inScope = (
  preview: OperationPreflight,
  scope: LocaleScope | undefined,
  operation: PayloadOperation
): OperationPreflight => {
  if (!scope) {
    return preview;
  }

  const scoped: OperationPreflight = {
    ...preview,
    fields: preview.fields.map((field) => scopedField(scope, operation, field)),
    sentence: inLocaleSentence(preview.sentence, scope.code),
  };

  const warning = [preview.warning ?? "", publishWarning(scope, operation)]
    .filter(Boolean)
    .join(" ");

  if (warning) {
    scoped.warning = warning;
  }

  return scoped;
};
