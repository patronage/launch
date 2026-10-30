import type { CollectionConfig, GeneratePreviewURL } from "payload";

/** The document Payload hands to a preview URL function. */
type EditedDoc = Parameters<GeneratePreviewURL>[0];

/** The route that turns on draft mode for a logged-in editor, then redirects. */
export const PREVIEW_ROUTE = "/next/preview";

/** How long autosave waits after a change, which paces Live Preview. */
const AUTOSAVE_INTERVAL_MS = 375;

/**
 * The preview button, Live Preview and autosave for a collection whose
 * documents have a front-end address. `pathOf` gets the document's path, or
 * undefined before it has one.
 */
export const previewable = <Doc extends object>(
  pathOf: (doc: Partial<Doc>) => string | undefined
) => {
  const previewUrl = (doc: EditedDoc) => {
    // SAFETY: Payload passes the document being edited, possibly unsaved, so
    // any of its fields may be missing.
    const path = pathOf(doc as Partial<Doc>);

    return path
      ? `${PREVIEW_ROUTE}?${new URLSearchParams({ path }).toString()}`
      : null;
  };

  return {
    admin: {
      livePreview: { url: ({ data }) => previewUrl(data) },
      preview: (doc) => previewUrl(doc),
    },
    versions: {
      drafts: {
        autosave: { interval: AUTOSAVE_INTERVAL_MS },
        // Without validation, Payload's create view saves an empty draft and
        // redirects to it during render. Its catch only lets through an error
        // whose message is exactly NEXT_REDIRECT, and vinext appends the URL,
        // so the create view rendered blank. Validated drafts skip that path:
        // a new document autosaves once its required fields are filled.
        validate: true,
      },
    },
  } satisfies Pick<CollectionConfig, "admin" | "versions">;
};
