import type { FlattenedBlock, FlattenedField } from "payload";

/**
 * What `getEditingInfo` reports about a set of fields, read from Payload's
 * flattened field config. Nothing here reads a document: it describes the
 * schema, so the MCP gateway can check a write before a person is asked to
 * approve it.
 */

/** Rows inside rows are described this deep; anything deeper is left out. */
export const MAX_ROW_DEPTH = 4;

/** One block type a blocks field takes, and what a row of it holds. */
export interface BlockInfo {
  /**
   * Localized fields in one row, by path from the row. A field under one of
   * them is localized with it; every other field of the row holds one value
   * for all locales.
   */
  localizedFields: string[];
  /** Rich text fields in one row, by path from the row. */
  richTextFields: string[];
  /** Array and blocks fields in one row. */
  rowFields: RowsFieldInfo[];
  slug: string;
}

/** An array or blocks field: a list of rows, each with its own `id`. */
export interface RowsFieldInfo {
  /** Blocks fields only: the block types a row may be. */
  blocks?: BlockInfo[];
  /** Array fields only: localized fields in one row, by path from the row. */
  localizedFields?: string[];
  /**
   * The field's path from the document, or from the row that holds it.
   * Groups and named tabs join with a dot: `hero.links`.
   */
  path: string;
  /** Array fields only: rich text fields in one row, by path from the row. */
  richTextFields?: string[];
  /** Array fields only: array and blocks fields in one row. */
  rowFields?: RowsFieldInfo[];
  type: "array" | "blocks";
}

/** A relationship or upload field outside any row. */
export interface RelationFieldInfo {
  hasMany: boolean;
  path: string;
  /**
   * Whether the field names its collections as a list. Payload then stores
   * each value as `{ relationTo, value }`, also when the list has one entry,
   * and a query has to ask for `<path>.value`.
   */
  polymorphic: boolean;
  relationTo: string[];
}

export interface FieldsInfo {
  /** Whether any field, at any depth, is localized. */
  localized: boolean;
  /**
   * Every localized field outside a row, by path: the fields Payload keeps
   * one value of for each locale. A field under one of them (in a localized
   * group, or in the rows of a localized array) is localized with it. Every
   * other field holds one value for all locales.
   */
  localizedFields: string[];
  relationFields: RelationFieldInfo[];
  /** Every rich text field outside a row, by path. */
  richTextFields: string[];
  rowFields: RowsFieldInfo[];
}

/** Finds a block a blocks field names by its slug (`blockReferences`). */
export type BlockLookup = (slug: string) => FlattenedBlock | undefined;

interface Walk {
  depth: number;
  lookup: BlockLookup;
  prefix: string;
}

interface DescribedBlock {
  info: BlockInfo;
  localized: boolean;
}

interface DescribedRows {
  localized: boolean;
  rows: RowsFieldInfo;
}

const emptyInfo = (): FieldsInfo => ({
  localized: false,
  localizedFields: [],
  relationFields: [],
  richTextFields: [],
  rowFields: [],
});

const merge = (into: FieldsInfo, from: FieldsInfo): void => {
  into.localized ||= from.localized;
  into.localizedFields.push(...from.localizedFields);
  into.relationFields.push(...from.relationFields);
  into.richTextFields.push(...from.richTextFields);
  into.rowFields.push(...from.rowFields);
};

const isLocalized = (field: FlattenedField): boolean =>
  "localized" in field && field.localized === true;

const blockInfo = (
  entry: FlattenedBlock | string,
  walk: Walk
): DescribedBlock | undefined => {
  // Payload's own config type: a block, or the slug of one kept in the
  // config's `blocks` list.
  // oxlint-disable-next-line anti-slop/no-runtime-typeof
  const block = typeof entry === "string" ? walk.lookup(entry) : entry;

  if (!block) {
    return undefined;
  }

  // oxlint-disable-next-line no-use-before-define -- rows hold fields, which hold rows
  const fields = describeFields(block.flattenedFields, {
    depth: walk.depth + 1,
    lookup: walk.lookup,
    prefix: "",
  });

  return {
    info: {
      localizedFields: fields.localizedFields,
      richTextFields: fields.richTextFields,
      rowFields: fields.rowFields,
      slug: block.slug,
    },
    localized: fields.localized,
  };
};

const describeRows = (
  field: Extract<FlattenedField, { type: "array" | "blocks" }>,
  path: string,
  walk: Walk
): DescribedRows => {
  if (field.type === "array") {
    // oxlint-disable-next-line no-use-before-define -- rows hold fields, which hold rows
    const fields = describeFields(field.flattenedFields, {
      depth: walk.depth + 1,
      lookup: walk.lookup,
      prefix: "",
    });

    return {
      localized: fields.localized,
      rows: {
        localizedFields: fields.localizedFields,
        path,
        richTextFields: fields.richTextFields,
        rowFields: fields.rowFields,
        type: "array",
      },
    };
  }

  const blocks = field.blocks.flatMap((entry) => {
    const described = blockInfo(entry, walk);

    return described ? [described] : [];
  });

  return {
    localized: blocks.some((block) => block.localized),
    rows: { blocks: blocks.map((block) => block.info), path, type: "blocks" },
  };
};

/**
 * Describes a document's, a global's or a row's fields. Unnamed tabs, rows
 * and collapsibles are already flattened away by Payload; groups and named
 * tabs keep their name in the path.
 */
export const describeFields = (
  fields: readonly FlattenedField[],
  walk: Walk
): FieldsInfo => {
  const info = emptyInfo();

  for (const field of fields) {
    const path = `${walk.prefix}${field.name}`;

    if (isLocalized(field)) {
      info.localized = true;
      info.localizedFields.push(path);
    }

    switch (field.type) {
      case "array":
      case "blocks": {
        // Past the depth limit the field is still there, but its rows are
        // not described, so nothing claims to know what they hold.
        if (walk.depth < MAX_ROW_DEPTH) {
          const described = describeRows(field, path, walk);

          info.localized ||= described.localized;
          info.rowFields.push(described.rows);
        }

        break;
      }

      case "group":
      case "tab": {
        merge(
          info,
          describeFields(field.flattenedFields, {
            ...walk,
            prefix: `${path}.`,
          })
        );

        break;
      }

      case "relationship":
      case "upload": {
        info.relationFields.push({
          hasMany: field.hasMany === true,
          path,
          polymorphic: Array.isArray(field.relationTo),
          relationTo: [field.relationTo].flat(),
        });

        break;
      }

      case "richText": {
        info.richTextFields.push(path);

        break;
      }

      default: {
        break;
      }
    }
  }

  return info;
};

/** The fields of a collection or global, from the top. */
export const describeDocumentFields = (
  fields: readonly FlattenedField[],
  lookup: BlockLookup
): FieldsInfo => describeFields(fields, { depth: 0, lookup, prefix: "" });

const blockBySlug = (
  field: Extract<FlattenedField, { type: "blocks" }>,
  slug: string | undefined,
  lookup: BlockLookup
): FlattenedBlock | undefined => {
  for (const entry of field.blocks) {
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Payload's own config type
    const block = typeof entry === "string" ? lookup(entry) : entry;

    if (block?.slug === slug) {
      return block;
    }
  }

  return undefined;
};

/**
 * Finds a field by its schema path: the field names from the top down to
 * it, with a block's slug after each blocks field, such as
 * `["layout", "content", "body"]`. Groups, named tabs and arrays are stepped
 * into by name alone. Undefined for a path that leads nowhere.
 */
export const findFieldByPath = (
  fields: readonly FlattenedField[],
  path: readonly string[],
  lookup: BlockLookup
): FlattenedField | undefined => {
  const [name, ...rest] = path;
  const field = fields.find((entry) => entry.name === name);

  if (!field || rest.length === 0) {
    return field;
  }

  switch (field.type) {
    case "array":
    case "group":
    case "tab": {
      return findFieldByPath(field.flattenedFields, rest, lookup);
    }

    case "blocks": {
      const [slug, ...inBlock] = rest;
      const block = blockBySlug(field, slug, lookup);

      return block && inBlock.length > 0
        ? findFieldByPath(block.flattenedFields, inBlock, lookup)
        : undefined;
    }

    default: {
      return undefined;
    }
  }
};
