/**
 * The demo form the Apply page places with its `form` section. EmDash's seed
 * can't hold plugin data, so scripts/setup.ts creates it through the forms
 * plugin's admin API. Edit it in the admin under Plugins > Forms.
 */
export const demoForm = {
  name: "Garden application",
  pages: [
    {
      fields: [
        {
          id: "name",
          label: "Your name",
          name: "name",
          required: true,
          type: "text",
          width: "half",
        },
        {
          id: "email",
          label: "Email",
          name: "email",
          required: true,
          type: "email",
          width: "half",
        },
        {
          id: "address",
          label: "Lot address",
          name: "address",
          required: true,
          type: "text",
          width: "full",
        },
        {
          id: "owner",
          label: "Who owns the lot?",
          name: "owner",
          options: [
            { label: "The city", value: "city" },
            { label: "A private owner", value: "private" },
            { label: "We don't know", value: "unknown" },
          ],
          required: true,
          type: "select",
          width: "full",
        },
        {
          id: "neighbors",
          helpText: "Five neighbors who will help, one per line.",
          label: "Neighbors",
          name: "neighbors",
          required: false,
          type: "textarea",
          width: "full",
        },
      ],
    },
  ],
  settings: {
    confirmationMessage:
      "Thanks for applying. We read every application and will be in touch within two weeks.",
    spamProtection: "honeypot",
    submitLabel: "Send application",
  },
  slug: "garden-application",
};
