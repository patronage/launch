import {
  ApplyConflictError,
  deepEqual,
  NEW_ROW,
  previewValue,
  REMOVED_ROW,
} from "@patronage/mcp-core";
import type { FieldSnapshot, JsonObject, JsonValue } from "@patronage/mcp-core";

import type { RowsField } from "./payload-editing";
import { isLocalizedPath, scopeLabel } from "./payload-locale";
import type { RowChange } from "./payload-operations";
import {
  humanize,
  parseRowFieldPath,
  parseRowsFieldPath,
  topLevelField,
} from "./payload-row-paths";
import type { RowPathPart } from "./payload-row-paths";

// Changes to single rows of array and blocks fields, worked out on a copy of
// the document. Payload saves an array or blocks field whole, so a row
// change is: read the draft, change the copy, and send the top-level fields
// that hold the changed rows. Everything here is that middle step and the
// check afterwards that each change landed. Nothing here talks to Payload,
// apart from the two rich text conversions it is handed.

/** What a document or one row holds, as Payload's `getEditingInfo` says. */
export interface RowContext {
  // The localized fields at this level, by path from it. Without the list
  // nothing here is known to be localized.
  localizedFields?: string[] | undefined;
  richTextFields: string[];
  rowFields: RowsField[];
}

/** Rich text conversions for a field inside a row, by its schema path. */
export interface RowConverters {
  toMarkdown: (
    schemaPath: string[],
    value: JsonValue | undefined
  ) => Promise<string>;
  toRichText: (schemaPath: string[], markdown: string) => Promise<JsonObject>;
}

/** How one change is checked against the document read back after a write. */
export type RowCheck =
  | { fieldParts: RowPathPart[]; kind: "insert"; row: JsonObject }
  | { fieldParts: RowPathPart[]; kind: "order" }
  | { kind: "none" }
  | {
      kind: "set";
      parts: RowPathPart[];
      previous: JsonValue | undefined;
      value: JsonValue;
    };

export interface RowsPatch {
  // One per change, in order.
  checks: RowCheck[];
  // One per change, in order: what the approver sees.
  snapshots: FieldSnapshot[];
  // The top-level fields that differ from the document, sorted.
  touched: string[];
  // The document with every change made.
  working: JsonObject;
}

const LABEL_SEPARATOR = " › ";

// A JSON value's shape is only known at run time, and a parsed copy would
// not be the same object the changes are made on.
const isRecord = (value: JsonValue | undefined): value is JsonObject =>
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  typeof value === "object" && value !== null && !Array.isArray(value);

const conflict = (code: string, message: string): ApplyConflictError =>
  new ApplyConflictError(code, message);

const rowId = (row: JsonValue | undefined): string | undefined =>
  isRecord(row) && row.id !== undefined && row.id !== null
    ? String(row.id)
    : undefined;

interface Located {
  context: RowContext;
  // The document, or the row the path has reached.
  holder: JsonObject;
  labels: string[];
  // Whether a rows field the path went through is localized: each locale
  // then has rows of its own, and everything in them is that locale's.
  localized: boolean;
  // The field names after the last row.
  names: string[];
  // Field names from the document down, with a block's slug after each
  // blocks field.
  schemaPath: string[];
}

interface FoundRows {
  field: RowsField;
  rows: JsonValue[];
}

// The array a rows field holds. A field with no rows yet can be stored as
// null; it becomes an empty list on the copy, so a row can be put in it.
const rowsAt = (located: Located, shown: string): FoundRows => {
  const path = located.names.join(".");
  const field = located.context.rowFields.find((entry) => entry.path === path);

  if (!field) {
    throw conflict(
      "not_a_rows_field",
      `${shown}: ${path || "this"} is not an array or blocks field Payload describes here`
    );
  }

  let parent = located.holder;

  for (const name of located.names.slice(0, -1)) {
    const next = parent[name];

    if (!isRecord(next)) {
      throw conflict("not_a_rows_field", `${shown}: ${name} holds no fields`);
    }

    parent = next;
  }

  const last = located.names.at(-1) ?? "";
  const value = parent[last];

  if (value === undefined || value === null) {
    const empty: JsonValue[] = [];

    parent[last] = empty;

    return { field, rows: empty };
  }

  if (!Array.isArray(value)) {
    throw conflict("not_a_rows_field", `${shown}: ${path} holds no rows`);
  }

  return { field, rows: value };
};

interface RowKind {
  context: RowContext;
  // Blocks only: the row's block type.
  slug?: string;
}

const kindOfRow = (
  field: RowsField,
  row: JsonObject,
  shown: string
): RowKind => {
  if (field.type === "array") {
    return {
      context: {
        localizedFields: field.localizedFields,
        richTextFields: field.richTextFields ?? [],
        rowFields: field.rowFields ?? [],
      },
    };
  }

  const slug = String(row.blockType ?? "");
  const block = field.blocks?.find((entry) => entry.slug === slug);

  if (!block) {
    throw conflict(
      "unknown_block_type",
      `${shown}: Payload describes no ${slug || "such"} block in ${field.path}`
    );
  }

  return {
    context: {
      localizedFields: block.localizedFields,
      richTextFields: block.richTextFields,
      rowFields: block.rowFields,
    },
    slug,
  };
};

// Whether the field the path has reached holds one locale's value: it, a
// field above it or a rows field on the way is localized. Otherwise every
// locale shares it.
const isPerLocale = (located: Located): boolean =>
  located.localized ||
  isLocalizedPath(
    located.context.localizedFields ?? [],
    located.names.join(".")
  );

const rowLabel = (kind: RowKind, index: number): string =>
  kind.slug === undefined
    ? `row ${index + 1}`
    : `${humanize(kind.slug)} (row ${index + 1})`;

const indexOfRow = (rows: JsonValue[], id: string): number =>
  rows.findIndex((row) => rowId(row) === id);

const stepInto = (located: Located, id: string, shown: string): Located => {
  const { field, rows } = rowsAt(located, shown);
  const index = indexOfRow(rows, id);
  const row = rows[index];

  if (!isRecord(row)) {
    throw conflict(
      "unknown_row",
      `${shown}: ${located.names.join(".")} has no row ${id}`
    );
  }

  const kind = kindOfRow(field, row, shown);

  return {
    context: kind.context,
    holder: row,
    labels: [
      ...located.labels,
      ...located.names.map((name) => humanize(name)),
      rowLabel(kind, index),
    ],
    localized: isPerLocale(located),
    names: [],
    schemaPath: [
      ...located.schemaPath,
      ...located.names,
      ...(kind.slug === undefined ? [] : [kind.slug]),
    ],
  };
};

// Follows a path from the document, row by row. What is left in `names` is
// the field the path ends at, inside the last row it reached.
const locate = (
  document: JsonObject,
  context: RowContext,
  parts: RowPathPart[],
  shown: string
): Located => {
  let located: Located = {
    context,
    holder: document,
    labels: [],
    localized: false,
    names: [],
    schemaPath: [],
  };

  for (const part of parts) {
    located =
      "name" in part
        ? { ...located, names: [...located.names, part.name] }
        : stepInto(located, part.rowId, shown);
  }

  return located;
};

const labelOf = (located: Located, last?: string): string =>
  [
    ...located.labels,
    ...located.names.map((name) => humanize(name)),
    ...(last === undefined ? [] : [last]),
  ].join(LABEL_SEPARATOR);

// The object that holds a row's field, through any groups on the way.
const fieldHolder = (located: Located, shown: string): JsonObject => {
  let { holder } = located;

  for (const name of located.names.slice(0, -1)) {
    const next = holder[name];

    if (!isRecord(next)) {
      throw conflict("unknown_field", `${shown}: ${name} holds no fields`);
    }

    holder = next;
  }

  return holder;
};

interface Change {
  check: RowCheck;
  // Whether the change is to one locale's value, or to what all share.
  perLocale: boolean;
  snapshot: FieldSnapshot;
}

// A row as the approver reads it: its fields, without the id Payload gave it.
const rowPreview = (row: JsonValue | undefined): string => {
  if (!isRecord(row)) {
    return previewValue(row);
  }

  const { id: _id, ...fields } = row;

  return previewValue(fields);
};

const setField = (
  working: JsonObject,
  context: RowContext,
  change: Extract<RowChange, { op: "set" }>
): Change => {
  const parts = parseRowFieldPath(change.path);
  const located = locate(working, context, parts, change.path);
  const field = located.names.join(".");

  // The field itself, or anything inside its stored Lexical value: a `set`
  // there would skip the Markdown conversion and its check for content
  // Markdown cannot carry.
  const richText = located.context.richTextFields.find(
    (entry) => field === entry || field.startsWith(`${entry}.`)
  );

  if (richText !== undefined) {
    throw conflict(
      "use_set_markdown",
      `${change.path} is ${field === richText ? "" : "inside "}rich text; change the field with set_markdown`
    );
  }

  const rows = located.context.rowFields.find(
    (entry) => field === entry.path || field.startsWith(`${entry.path}.`)
  );

  if (rows) {
    throw conflict(
      "rows_field",
      `${change.path} holds rows; change them with insert, remove and move, or name one row with [id=…]`
    );
  }

  const holder = fieldHolder(located, change.path);
  const last = located.names.at(-1) ?? "";
  const previous = holder[last];

  holder[last] = change.value;

  return {
    check: { kind: "set", parts, previous, value: change.value },
    perLocale: isPerLocale(located),
    snapshot: {
      after: previewValue(change.value),
      before: previewValue(previous),
      changed: !deepEqual(previous, change.value),
      label: labelOf(located),
      path: change.path,
    },
  };
};

const setMarkdown = async (
  working: JsonObject,
  context: RowContext,
  change: Extract<RowChange, { op: "set_markdown" }>,
  converters: RowConverters
): Promise<Change> => {
  const parts = parseRowFieldPath(change.path);
  const located = locate(working, context, parts, change.path);
  const field = located.names.join(".");

  if (!located.context.richTextFields.includes(field)) {
    throw conflict("not_rich_text", `${change.path} does not take Markdown`);
  }

  const holder = fieldHolder(located, change.path);
  const last = located.names.at(-1) ?? "";
  const previous = holder[last];
  const schemaPath = [...located.schemaPath, ...located.names];

  // Both conversions run even when nothing changed: they prove Payload
  // accepts the Markdown before anyone is asked to approve it.
  const [before, value] = await Promise.all([
    converters.toMarkdown(schemaPath, previous),
    converters.toRichText(schemaPath, change.markdown),
  ]);

  // Only trailing whitespace is ignored: leading spaces change how Markdown
  // parses. Unchanged Markdown leaves the stored value as it is, because a
  // fresh conversion seldom matches the stored JSON byte for byte.
  const changed = before.trimEnd() !== change.markdown.trimEnd();

  if (changed) {
    holder[last] = value;
  }

  return {
    check: changed ? { kind: "set", parts, previous, value } : { kind: "none" },
    perLocale: isPerLocale(located),
    snapshot: {
      after: previewValue(change.markdown),
      before: previewValue(before),
      changed,
      label: labelOf(located),
      path: change.path,
    },
  };
};

// Where a row goes: at the start, or right after another row.
const indexAfter = (
  rows: JsonValue[],
  afterId: string | null,
  shown: string
): number => {
  if (afterId === null) {
    return 0;
  }

  const index = indexOfRow(rows, afterId);

  if (index === -1) {
    throw conflict("unknown_row", `${shown} has no row ${afterId}`);
  }

  return index + 1;
};

const insertRow = (
  working: JsonObject,
  context: RowContext,
  change: Extract<RowChange, { op: "insert" }>,
  inserts: Map<string, number>
): Change => {
  const fieldParts = parseRowsFieldPath(change.field);
  const located = locate(working, context, fieldParts, change.field);
  const { field, rows } = rowsAt(located, change.field);
  const row: JsonObject = structuredClone(change.row);

  if (field.type === "blocks") {
    const slugs = (field.blocks ?? []).map((block) => block.slug);

    if (!slugs.includes(String(row.blockType ?? ""))) {
      throw conflict(
        "unknown_block_type",
        `${change.field}: a new row needs a blockType, one of ${slugs.join(", ")}`
      );
    }
  }

  const index = indexAfter(rows, change.after_id, change.field);
  const count = (inserts.get(change.field) ?? 0) + 1;

  inserts.set(change.field, count);
  rows.splice(index, 0, row);

  return {
    check: { fieldParts, kind: "insert", row },
    perLocale: isPerLocale(located),
    snapshot: {
      after: rowPreview(row),
      before: NEW_ROW,
      changed: true,
      label: labelOf(located, `new row ${index + 1}`),
      path: `${change.field}[new${count === 1 ? "" : ` ${count}`}]`,
    },
  };
};

interface ExistingRow {
  index: number;
  label: string;
  row: JsonObject;
}

const existingRow = (
  located: Located,
  found: FoundRows,
  id: string,
  shown: string
): ExistingRow => {
  const index = indexOfRow(found.rows, id);
  const row = found.rows[index];

  if (!isRecord(row)) {
    throw conflict("unknown_row", `${shown} has no row ${id}`);
  }

  return {
    index,
    label: labelOf(
      located,
      rowLabel(kindOfRow(found.field, row, shown), index)
    ),
    row,
  };
};

const removeRow = (
  working: JsonObject,
  context: RowContext,
  change: Extract<RowChange, { op: "remove" }>
): Change => {
  const fieldParts = parseRowsFieldPath(change.field);
  const located = locate(working, context, fieldParts, change.field);
  const found = rowsAt(located, change.field);
  const row = existingRow(located, found, change.row_id, change.field);

  found.rows.splice(row.index, 1);

  return {
    check: { fieldParts, kind: "order" },
    perLocale: isPerLocale(located),
    snapshot: {
      after: REMOVED_ROW,
      before: rowPreview(row.row),
      changed: true,
      label: row.label,
      path: `${change.field}[id=${change.row_id}]`,
    },
  };
};

const moveRow = (
  working: JsonObject,
  context: RowContext,
  change: Extract<RowChange, { op: "move" }>
): Change => {
  const fieldParts = parseRowsFieldPath(change.field);
  const located = locate(working, context, fieldParts, change.field);
  const found = rowsAt(located, change.field);
  const row = existingRow(located, found, change.row_id, change.field);
  const total = found.rows.length;

  found.rows.splice(row.index, 1);

  const index = indexAfter(found.rows, change.after_id, change.field);

  found.rows.splice(index, 0, row.row);

  return {
    check: { fieldParts, kind: "order" },
    perLocale: isPerLocale(located),
    snapshot: {
      after: `position ${index + 1} of ${total}`,
      before: `position ${row.index + 1} of ${total}`,
      changed: index !== row.index,
      label: row.label,
      path: `${change.field}[id=${change.row_id}]`,
    },
  };
};

interface PatchState {
  context: RowContext;
  converters: RowConverters;
  inserts: Map<string, number>;
  working: JsonObject;
}

const makeChange = async (
  state: PatchState,
  change: RowChange
): Promise<Change> => {
  switch (change.op) {
    case "insert": {
      return insertRow(state.working, state.context, change, state.inserts);
    }

    case "move": {
      return moveRow(state.working, state.context, change);
    }

    case "remove": {
      return removeRow(state.working, state.context, change);
    }

    case "set": {
      return setField(state.working, state.context, change);
    }

    default: {
      return await setMarkdown(
        state.working,
        state.context,
        change,
        state.converters
      );
    }
  }
};

// In order, one after another: a later change sees what an earlier one did.
const changesFrom = async (
  state: PatchState,
  changes: RowChange[],
  index: number
): Promise<Change[]> => {
  const change = changes.at(index);

  if (change === undefined) {
    return [];
  }

  const made = await makeChange(state, change);

  return [made, ...(await changesFrom(state, changes, index + 1))];
};

/** The top-level field each change's path starts in. */
export const changedTopLevelFields = (changes: RowChange[]): string[] => [
  ...new Set(
    changes.map((change) =>
      topLevelField(
        "path" in change
          ? parseRowFieldPath(change.path)
          : parseRowsFieldPath(change.field)
      )
    )
  ),
];

/**
 * Makes every change on a copy of the document, in order. Throws
 * `ApplyConflictError` for a change that cannot be made: a row that is not
 * there, a path Payload does not describe, a block type a field does not
 * take.
 */
export const patchRows = async (
  document: JsonObject,
  context: RowContext,
  changes: RowChange[],
  converters: RowConverters,
  // The locale the changes are made in, on a target that has localized
  // fields. Each change is then labelled with who it is for.
  locale?: string
): Promise<RowsPatch> => {
  const working: JsonObject = structuredClone(document);

  const made = await changesFrom(
    { context, converters, inserts: new Map(), working },
    changes,
    0
  );

  return {
    checks: made.map((change) => change.check),
    snapshots: made.map((change) =>
      locale === undefined
        ? change.snapshot
        : {
            ...change.snapshot,
            label: scopeLabel(
              locale,
              change.snapshot.label ?? change.snapshot.path,
              change.perLocale
            ),
          }
    ),
    touched: changedTopLevelFields(changes)
      .filter((field) => !deepEqual(document[field], working[field]))
      .toSorted(),
    working,
  };
};

export interface RowsReadback {
  changed: string[];
  // The ids Payload gave the rows that were put in, in the order asked.
  inserted: string[];
  missed: string[];
  normalized: string[];
}

type Landed = "changed" | "missed" | "normalized";

interface Verdict {
  inserted?: string;
  landed: Landed;
}

const rowsOrUndefined = (
  document: JsonObject,
  context: RowContext,
  parts: RowPathPart[]
): JsonValue[] | undefined => {
  try {
    return rowsAt(locate(document, context, parts, ""), "").rows;
  } catch {
    return undefined;
  }
};

// Whether the rows Payload stored are the rows that were sent, in the same
// order. A row without an id on the copy is one that was put in: Payload
// gives it an id the copy cannot know.
const sameOrder = (expected: JsonValue[], stored: JsonValue[]): boolean => {
  const known = new Set(expected.map((row) => rowId(row)));

  return (
    expected.length === stored.length &&
    expected.every((row, index) => {
      const id = rowId(row);
      const storedId = rowId(stored[index]);

      return id === undefined ? !known.has(storedId) : id === storedId;
    })
  );
};

const checkSet = (
  check: Extract<RowCheck, { kind: "set" }>,
  after: JsonObject,
  context: RowContext
): Verdict => {
  let stored: JsonValue | undefined;

  try {
    const located = locate(after, context, check.parts, "");

    stored = fieldHolder(located, "")[located.names.at(-1) ?? ""];
  } catch {
    return { landed: "missed" };
  }

  if (deepEqual(stored, check.value)) {
    return { landed: "changed" };
  }

  return {
    landed: deepEqual(stored, check.previous) ? "missed" : "normalized",
  };
};

const checkInsert = (
  check: Extract<RowCheck, { kind: "insert" }>,
  expected: JsonValue[],
  stored: JsonValue[]
): Verdict => {
  const row = stored[expected.indexOf(check.row)];

  if (!isRecord(row)) {
    return { landed: "missed" };
  }

  const asAsked = Object.entries(check.row).every(([key, value]) =>
    deepEqual(row[key], value)
  );

  return {
    inserted: rowId(row) ?? "",
    landed: asAsked ? "changed" : "normalized",
  };
};

const checkOne = (
  check: RowCheck,
  patch: RowsPatch,
  after: JsonObject,
  context: RowContext
): Verdict | undefined => {
  if (check.kind === "none") {
    return undefined;
  }

  if (check.kind === "set") {
    return checkSet(check, after, context);
  }

  const expected = rowsOrUndefined(patch.working, context, check.fieldParts);
  const stored = rowsOrUndefined(after, context, check.fieldParts);

  if (!(expected && stored && sameOrder(expected, stored))) {
    return { landed: "missed" };
  }

  return check.kind === "insert"
    ? checkInsert(check, expected, stored)
    : { landed: "changed" };
};

/**
 * Reads each change back from the document as Payload stored it. A change
 * the preview showed as no change is left out; one Payload stored in another
 * form than it was sent is `normalized` as well as `changed`.
 */
export const readBackRows = (
  patch: RowsPatch,
  after: JsonObject,
  context: RowContext
): RowsReadback => {
  const readback: RowsReadback = {
    changed: [],
    inserted: [],
    missed: [],
    normalized: [],
  };

  for (const [index, check] of patch.checks.entries()) {
    const snapshot = patch.snapshots[index];
    const verdict = checkOne(check, patch, after, context);

    if (!(snapshot?.changed && verdict)) {
      continue;
    }

    if (verdict.landed === "missed") {
      readback.missed.push(snapshot.path);
    } else {
      readback.changed.push(snapshot.path);
    }

    if (verdict.landed === "normalized") {
      readback.normalized.push(snapshot.path);
    }

    if (verdict.inserted) {
      readback.inserted.push(verdict.inserted);
    }
  }

  return readback;
};
