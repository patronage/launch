import type { ReactNode } from "react";

import "./styles.css";

export const metadata = {
  description: "Payload running under vinext on Cloudflare Workers.",
  title: "Launch Payload",
};

const RootLayout = ({ children }: { children: ReactNode }) => (
  <html lang="en">
    <body>
      <main>{children}</main>
    </body>
  </html>
);

export default RootLayout;
