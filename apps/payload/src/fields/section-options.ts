import { CONTAINER_WIDTHS, SKINS, SPACINGS } from "@launch/content-model";
import type { Field } from "payload";

const options = (values: readonly string[]) =>
  values.map((value) => ({ label: value, value }));

// Postgres caps identifiers at 63 characters, and the default enum names
// (enum__pages_v_blocks_<block>_section_options_<field>) run over it. Payload
// passes the group's table name, so drop the group's part from it.
const select = (
  name: string,
  column: string,
  values: readonly string[],
  defaultValue: string
) =>
  ({
    defaultValue,
    enumName: ({ tableName = "" }: { tableName?: string }) =>
      `enum_${tableName.replace(/_section_options$/u, "")}_${column}`,
    name,
    options: options(values),
    required: true,
    type: "select",
  }) as const;

/**
 * Framing options shared by every section block. Names and values follow
 * `SectionOptions` in @launch/content-model; `anchor` is the editor's input,
 * which the adapter slugifies into the content model's `slug`.
 */
export const sectionOptions: Field = {
  fields: [
    {
      fields: [
        select("skin", "skin", SKINS, "light"),
        select("width", "width", CONTAINER_WIDTHS, "default"),
      ],
      type: "row",
    },
    {
      fields: [
        select("paddingTop", "padding_top", SPACINGS, "md"),
        select("paddingBottom", "padding_bottom", SPACINGS, "md"),
      ],
      type: "row",
    },
    {
      admin: {
        description: "Id for in-page links, e.g. programs for /#programs.",
      },
      name: "anchor",
      type: "text",
    },
    {
      admin: {
        description: "Hidden sections are saved but not rendered.",
      },
      defaultValue: false,
      name: "hidden",
      type: "checkbox",
    },
  ],
  interfaceName: "SectionOptions",
  label: "Section options",
  name: "sectionOptions",
  type: "group",
};
