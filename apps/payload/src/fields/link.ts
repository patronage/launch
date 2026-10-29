import { LINK_VARIANTS } from "@launch/content-model";
import type { Field } from "payload";

/**
 * A link to a page or a URL, shaped after `Link` in @launch/content-model.
 * The adapter turns `reference` into a path and drops links without a label.
 * Pass `variant: false` where the design fixes the style, as on cards.
 */
export const link = (name = "link", { variant = true } = {}): Field => ({
  fields: [
    {
      fields: [
        {
          defaultValue: "reference",
          name: "type",
          options: [
            { label: "Page", value: "reference" },
            { label: "URL", value: "custom" },
          ],
          required: true,
          type: "radio",
        },
        { name: "newTab", type: "checkbox" },
      ],
      type: "row",
    },
    {
      fields: [
        { name: "label", type: "text" },
        ...(variant
          ? [
              {
                defaultValue: "primary",
                name: "variant",
                options: LINK_VARIANTS.map((value) => ({
                  label: value,
                  value,
                })),
                type: "select",
              } as const,
            ]
          : []),
      ],
      type: "row",
    },
    {
      admin: {
        condition: (_, siblingData) => siblingData?.type === "reference",
      },
      name: "reference",
      relationTo: ["pages"],
      type: "relationship",
    },
    {
      admin: {
        condition: (_, siblingData) => siblingData?.type === "custom",
      },
      name: "url",
      type: "text",
    },
  ],
  interfaceName: variant ? "Link" : "PlainLink",
  name,
  type: "group",
});

/** Buttons under a section's copy. */
export const links: Field = {
  fields: [link()],
  name: "links",
  type: "array",
};
