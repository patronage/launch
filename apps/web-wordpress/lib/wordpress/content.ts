import { cache } from "react";

import type { ContentFieldsFragment } from "@/gql/graphql";

import { wpQuery } from "./client";
import { ContentByUriQuery, PreviewContentQuery } from "./queries";

export type Content = ContentFieldsFragment;

/** The published page or post at a front-end path, or null. Deduped per request. */
export const getContentByUri = cache(
  async (uri: string): Promise<Content | null> => {
    const { nodeByUri } = await wpQuery(ContentByUriQuery, { uri });

    // SAFETY: nodeByUri also returns terms, users and content types, which come
    // back as {} because the query only selects ContentNode fields. A
    // databaseId means it is a ContentNode with the ContentFields selection.
    return nodeByUri && "databaseId" in nodeByUri
      ? (nodeByUri as Content)
      : null;
  }
);

/**
 * A page or post by ID as the preview user sees it: a draft as saved, or a
 * published post with its latest unsaved changes.
 */
export const getPreviewContent = cache(
  async (id: number): Promise<Content | null> => {
    const { contentNode } = await wpQuery(
      PreviewContentQuery,
      { id: String(id) },
      { previewDatabaseId: id }
    );

    return contentNode ?? null;
  }
);
