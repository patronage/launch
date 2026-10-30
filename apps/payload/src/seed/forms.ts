import type { Form } from "../payload-types";
import { paragraph, richText } from "./lexical";

/**
 * The Neighborhood Growers forms, built with the form-builder plugin. The
 * Apply page and the Get involved page each place one in a form section.
 */

type FormFields = NonNullable<Form["fields"]>;

const text = (name: string, label: string, required = true, width = 100) => ({
  blockType: "text" as const,
  label,
  name,
  required,
  width,
});

const email = (name: string, label: string) => ({
  blockType: "email" as const,
  label,
  name,
  required: true,
  width: 50,
});

const textarea = (name: string, label: string, required = false) => ({
  blockType: "textarea" as const,
  label,
  name,
  required,
});

const select = (
  name: string,
  label: string,
  options: string[],
  required = true
) => ({
  blockType: "select" as const,
  label,
  name,
  options: options.map((value) => ({ label: value, value })),
  required,
  width: 50,
});

const checkbox = (name: string, label: string, required = false) => ({
  blockType: "checkbox" as const,
  label,
  name,
  required,
});

export const FORMS = [
  {
    confirmation:
      "Thanks for applying. A garden mentor will be in touch within two weeks to set up a visit to the lot.",
    fields: [
      text("name", "Your name", true, 50),
      email("email", "Email"),
      text("lotAddress", "Lot address or nearest intersection"),
      select("neighborhood", "Neighborhood", [
        "Eastside",
        "Mill Creek",
        "Riverside",
        "Downtown",
        "Other",
      ]),
      select("neighbors", "Neighbors ready to garden", [
        "1–4",
        "5–9",
        "10 or more",
      ]),
      textarea(
        "about",
        "Tell us about the lot and who wants to grow there",
        true
      ),
      checkbox("permission", "We have, or can get, the owner's permission"),
    ] satisfies FormFields,
    submitLabel: "Send application",
    title: "Garden application",
  },
  {
    confirmation:
      "Thanks for signing up. We'll email you before the next volunteer day.",
    fields: [
      text("name", "Your name", true, 50),
      email("email", "Email"),
      select(
        "interest",
        "I'd like to help with",
        [
          "Harvest days",
          "Mentoring a new garden",
          "Seed library",
          "Tool share",
        ],
        false
      ),
      textarea("note", "Anything we should know?"),
      checkbox("newsletter", "Send me the monthly newsletter"),
    ] satisfies FormFields,
    submitLabel: "Sign up",
    title: "Volunteer sign-up",
  },
] as const;

export type FormTitle = (typeof FORMS)[number]["title"];

/** A form's data for the forms collection. */
export const formData = (form: (typeof FORMS)[number]) => ({
  confirmationMessage: richText(paragraph(form.confirmation)),
  confirmationType: "message" as const,
  fields: [...form.fields],
  submitButtonLabel: form.submitLabel,
  title: form.title,
});
