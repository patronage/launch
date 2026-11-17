import { ApplyValidationError } from "@patronage/mcp-core";

// The path grammar `patch_rows` addresses rows with. Field names join with a
// dot, and `[id=<rowId>]` after an array or blocks field picks one row of it:
//
//   layout[id=6650a1f2].cards[id=b7c1].title
//
// A path is only ever taken apart here, never evaluated: each part is a
// plain name or a row id, checked against the same rules as a top-level
// field name, so nothing in a path can reach outside the document.

/** One step of a row path: into a field by name, or into a row by its id. */
export type RowPathPart = { name: string } | { rowId: string };

// Rows inside rows are described four deep by Payload's `getEditingInfo`.
export const MAX_ROW_SELECTORS = 4;
export const MAX_PATH_PARTS = 16;
export const MAX_PATH_LENGTH = 400;

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/u;
export const ROW_ID = /^[A-Za-z0-9_-]{1,64}$/u;

// What Payload keeps for itself inside a row or a document.
const RESERVED_NAMES = new Set(["blockType", "createdAt", "id", "updatedAt"]);

const invalid = (path: string, why: string): ApplyValidationError =>
  new ApplyValidationError("invalid_operations", `${path}: ${why}`);

const PART = /^(?<name>[^.[\]]+)(?:\[id=(?<rowId>[^.[\]]+)\])?$/u;

/**
 * Takes a row path apart, or throws `ApplyValidationError` for one that is
 * not in the grammar. `field.name` steps and `[id=…]` steps come back in
 * order.
 */
export const parseRowPath = (path: string): RowPathPart[] => {
  if (path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw invalid(path.slice(0, 60), "a path is 1 to 400 characters");
  }

  const parts: RowPathPart[] = [];

  for (const step of path.split(".")) {
    const match = PART.exec(step);
    const name = match?.groups?.name ?? "";
    const rowId = match?.groups?.rowId;

    if (!NAME.test(name)) {
      throw invalid(path, "is not field names joined by dots");
    }

    if (RESERVED_NAMES.has(name)) {
      throw invalid(path, `Payload manages ${name} itself`);
    }

    parts.push({ name });

    if (rowId !== undefined) {
      if (!ROW_ID.test(rowId)) {
        throw invalid(path, "has a row id that is not letters and digits");
      }

      parts.push({ rowId });
    }
  }

  const selectors = parts.filter((part) => "rowId" in part).length;

  if (parts.length > MAX_PATH_PARTS || selectors > MAX_ROW_SELECTORS) {
    throw invalid(path, "goes deeper than rows are described");
  }

  return parts;
};

/** A path to a field inside a row: it picks a row, then names a field. */
export const parseRowFieldPath = (path: string): RowPathPart[] => {
  const parts = parseRowPath(path);
  const last = parts.at(-1);

  if (!parts.some((part) => "rowId" in part)) {
    throw invalid(
      path,
      "names no row; change a top-level field with update_draft"
    );
  }

  if (last === undefined || "rowId" in last) {
    throw invalid(path, "ends at a row, not at a field of it");
  }

  return parts;
};

/** A path to an array or blocks field itself: it ends at a field name. */
export const parseRowsFieldPath = (path: string): RowPathPart[] => {
  const parts = parseRowPath(path);
  const last = parts.at(-1);

  if (last === undefined || "rowId" in last) {
    throw invalid(path, "ends at a row, not at an array or blocks field");
  }

  return parts;
};

/** The first field a path goes through: the top-level field a write sends. */
export const topLevelField = (parts: RowPathPart[]): string => {
  const [first] = parts;

  return first !== undefined && "name" in first ? first.name : "";
};

/**
 * A field name or a block slug as a person reads it: `cardGrid` is
 * "Card grid", `sectionOptions` is "Section options".
 */
export const humanize = (name: string): string => {
  const words = name
    .replaceAll(/[_-]+/gu, " ")
    .replaceAll(/(?<lower>[a-z0-9])(?<upper>[A-Z])/gu, "$<lower> $<upper>")
    .trim()
    .toLowerCase();

  return words.charAt(0).toUpperCase() + words.slice(1);
};
