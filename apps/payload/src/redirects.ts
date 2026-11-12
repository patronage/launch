import { redirectsPlugin } from "@payloadcms/plugin-redirects";
import type { Field, TextFieldSingleValidation } from "payload";
import { text } from "payload/shared";

import { destinationUrlError, fromPathError } from "./lib/redirects";

/** Payload's own text checks, then `check` on a non-empty value. */
const validated =
  (check: (value: string) => string | undefined): TextFieldSingleValidation =>
  (value, options) => {
    const valid = text(value, options);

    return valid === true && value ? (check(value) ?? true) : valid;
  };

const withValidation = (field: Field): Field => {
  if (field.type === "text" && field.name === "from" && !field.hasMany) {
    return {
      ...field,
      admin: {
        ...field.admin,
        description:
          "The old path, such as /old-page. It applies only when no page or post is published there.",
      },
      validate: validated(fromPathError),
    };
  }

  if (field.type === "group" && "name" in field && field.name === "to") {
    return {
      ...field,
      fields: field.fields.map((child) =>
        child.type === "text" && child.name === "url" && !child.hasMany
          ? { ...child, validate: validated(destinationUrlError) }
          : child
      ),
    };
  }

  return field;
};

/**
 * Editor-managed redirects, followed by the front end when a path has nothing
 * published at it (lib/follow-redirect.ts). The types are the two statuses
 * Next's redirect functions send.
 */
export const redirects = () =>
  redirectsPlugin({
    collections: ["pages", "posts"],
    overrides: {
      admin: { defaultColumns: ["from", "to.type", "type"] },
      fields: ({ defaultFields }) => defaultFields.map(withValidation),
      versions: false,
    },
    redirectTypeFieldOverride: { defaultValue: "308" },
    redirectTypes: ["308", "307"],
  });
