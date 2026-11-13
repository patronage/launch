"use client";

import { LoadingOverlay, useAuth } from "@payloadcms/ui";
import { useEffect, useRef } from "react";

import { logOutOfPayloadAndAccess } from "@/lib/access-logout";

/** Logs out of Payload, then Access, once, while showing the loading overlay. */
export const AccessLogoutClient = () => {
  const { logOut } = useAuth();
  const started = useRef(false);

  useEffect(() => {
    if (started.current) {
      return;
    }

    started.current = true;
    void logOutOfPayloadAndAccess(logOut, (url) =>
      window.location.replace(url)
    );
  }, [logOut]);

  return <LoadingOverlay animationDuration="0ms" />;
};
