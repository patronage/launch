import type { FlattenedBlock, FlattenedField } from "payload";
import { describe, expect, it } from "vitest";

import {
  describeDocumentFields,
  findFieldByPath,
  MAX_ROW_DEPTH,
} from "./editing-info";
import type { BlockLookup } from "./editing-info";

const text = (name: string, localized = false): FlattenedField => ({
  localized,
  name,
  type: "text",
});

const richText = (name: string): FlattenedField => ({ name, type: "richText" });

const array = (name: string, fields: FlattenedField[]): FlattenedField => ({
  fields: [],
  flattenedFields: fields,
  name,
  type: "array",
});

const block = (slug: string, fields: FlattenedField[]): FlattenedBlock => ({
  fields: [],
  flattenedFields: fields,
  slug,
});

// No field in these tests names a block by slug.
const noBlocks: BlockLookup = () => {};

describe(describeDocumentFields, () => {
  it("lists rich text, relationship and upload fields by path", () => {
    const info = describeDocumentFields(
      [
        text("title"),
        richText("content"),
        { name: "hero", relationTo: "media", type: "upload" },
        {
          hasMany: true,
          name: "related",
          relationTo: ["pages", "posts"],
          type: "relationship",
        },
        {
          fields: [],
          flattenedFields: [
            richText("body"),
            { name: "image", relationTo: "media", type: "upload" },
          ],
          name: "banner",
          type: "group",
        },
      ],
      noBlocks
    );

    expect(info.richTextFields).toStrictEqual(["content", "banner.body"]);
    expect(info.relationFields).toStrictEqual([
      { hasMany: false, path: "hero", relationTo: ["media"] },
      { hasMany: true, path: "related", relationTo: ["pages", "posts"] },
      { hasMany: false, path: "banner.image", relationTo: ["media"] },
    ]);
    expect(info.rowFields).toStrictEqual([]);
    expect(info.localized).toBeFalsy();
  });

  it("describes an array's rows, and arrays inside a group", () => {
    const info = describeDocumentFields(
      [
        {
          fields: [],
          flattenedFields: [array("links", [text("label"), richText("note")])],
          name: "hero",
          type: "group",
        },
      ],
      noBlocks
    );

    expect(info.rowFields).toStrictEqual([
      {
        path: "hero.links",
        richTextFields: ["note"],
        rowFields: [],
        type: "array",
      },
    ]);
    // A row's rich text is the row's, not the document's.
    expect(info.richTextFields).toStrictEqual([]);
  });

  it("describes each block type of a blocks field", () => {
    const info = describeDocumentFields(
      [
        {
          blocks: [
            block("text", [richText("body")]),
            block("cards", [array("cards", [text("title")])]),
          ],
          name: "layout",
          type: "blocks",
        },
      ],
      noBlocks
    );

    expect(info.rowFields).toStrictEqual([
      {
        blocks: [
          { richTextFields: ["body"], rowFields: [], slug: "text" },
          {
            richTextFields: [],
            rowFields: [
              {
                path: "cards",
                richTextFields: [],
                rowFields: [],
                type: "array",
              },
            ],
            slug: "cards",
          },
        ],
        path: "layout",
        type: "blocks",
      },
    ]);
  });

  it("resolves a block named by slug, and skips one it cannot find", () => {
    const shared = block("quote", [richText("quote")]);

    const info = describeDocumentFields(
      [{ blocks: ["quote", "missing"], name: "layout", type: "blocks" }],
      (slug) => (slug === "quote" ? shared : undefined)
    );

    expect(info.rowFields).toStrictEqual([
      {
        blocks: [{ richTextFields: ["quote"], rowFields: [], slug: "quote" }],
        path: "layout",
        type: "blocks",
      },
    ]);
  });

  it("reports a localized field at any depth", () => {
    const top = describeDocumentFields([text("title", true)], noBlocks);

    const nested = describeDocumentFields(
      [
        {
          blocks: [block("cards", [array("cards", [text("title", true)])])],
          name: "layout",
          type: "blocks",
        },
      ],
      noBlocks
    );

    expect(top.localized).toBeTruthy();
    expect(nested.localized).toBeTruthy();
  });

  it("stops describing rows past the depth limit", () => {
    // A block that holds itself, as a recursive layout does.
    const nest = (depth: number): FlattenedField =>
      array(
        `level${depth}`,
        depth > MAX_ROW_DEPTH + 2 ? [] : [nest(depth + 1)]
      );

    const info = describeDocumentFields([nest(1)], noBlocks);

    let rows = info.rowFields;
    let levels = 0;

    while (rows.length > 0) {
      levels += 1;
      rows = rows[0]?.rowFields ?? [];
    }

    expect(levels).toBe(MAX_ROW_DEPTH);
  });
});

describe(findFieldByPath, () => {
  const card = array("cards", [text("title"), richText("note")]);
  const cardGrid = block("cardGrid", [text("heading"), card]);
  const content = block("content", [richText("body")]);

  const fields: FlattenedField[] = [
    richText("content"),
    {
      fields: [],
      flattenedFields: [richText("body"), array("links", [text("label")])],
      name: "hero",
      type: "group",
    },
    {
      blocks: [content, "cardGrid"],
      name: "layout",
      type: "blocks",
    },
  ];

  const lookup: BlockLookup = (slug) =>
    slug === "cardGrid" ? cardGrid : undefined;

  const typeAt = (path: string[]): string | undefined =>
    findFieldByPath(fields, path, lookup)?.type;

  it("finds a top-level field and one inside a group", () => {
    expect(typeAt(["content"])).toBe("richText");
    expect(typeAt(["hero", "body"])).toBe("richText");
    expect(typeAt(["hero", "links", "label"])).toBe("text");
  });

  it("steps through a blocks field by the block's slug", () => {
    expect(typeAt(["layout", "content", "body"])).toBe("richText");
    expect(typeAt(["layout", "cardGrid", "cards", "note"])).toBe("richText");
  });

  it("finds nothing for a path that leads nowhere", () => {
    expect(typeAt(["layout", "body"])).toBeUndefined();
    expect(typeAt(["layout", "quote", "body"])).toBeUndefined();
    expect(typeAt(["layout", "content"])).toBeUndefined();
    expect(typeAt(["content", "body"])).toBeUndefined();
    expect(typeAt(["missing"])).toBeUndefined();
  });
});
