import type { PluginConfig } from "@payloadcms/plugin-form-builder/types";

import { sectionBodyEditor } from "./blocks";

/**
 * The form-builder's forms collection, grouped with submissions. The
 * confirmation message uses the section body editor, so the adapter's Lexical
 * renderer draws everything an editor can write there.
 */
export const formOverrides: PluginConfig["formOverrides"] = {
  admin: { group: "Forms" },
  fields: ({ defaultFields }) =>
    defaultFields.map((field) =>
      "name" in field && field.name === "confirmationMessage"
        ? { ...field, editor: sectionBodyEditor }
        : field
    ),
};
