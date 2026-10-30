"use client";

import { RefreshRouteOnSave } from "@payloadcms/live-preview-react";
import { useRouter } from "next/navigation";

/**
 * Inside the admin's Live Preview, re-renders the page on the server each
 * time the document autosaves. The admin and the front end share an origin.
 */
export const LivePreviewRefresh = () => {
  const router = useRouter();

  return (
    <RefreshRouteOnSave
      refresh={() => router.refresh()}
      serverURL={globalThis.location?.origin ?? ""}
    />
  );
};
