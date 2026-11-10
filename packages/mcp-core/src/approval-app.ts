import {
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";

import { APPROVAL_CARD_SCRIPT } from "./approval-card-bundle.generated";
import { APPROVAL_STYLE, escapeHtml } from "./approval-page";

// MCP hosts may cache app resources by URI for the lifetime of a connector.
// The suffix is bumped whenever the embedded app shell changes incompatibly;
// the older URIs keep serving the current shell so a host pinned to one of
// them still gets a card that works against today's tools.
export const APPROVAL_APP_URI = "ui://patronage/cms-approval-v4.html";

export const LEGACY_APPROVAL_APP_URIS = [
  "ui://patronage/wordpress-approval.html",
  "ui://patronage/wordpress-approval-v2.html",
  "ui://patronage/wordpress-approval-v3.html",
];

export const APPROVAL_APP_META_KEY = "com.patronage/approval";
export const APPROVAL_APP_NAME = "CMS write approval";

// What the paused tool result hands the card, and nothing else. The host is
// expected to keep tool-result `_meta` out of the model's context, so the
// one-time approval token lives here and is never copied into `content` or
// `structuredContent`. Everything a person reads is fetched by the card
// itself, from `preview_write`, once the card is open.
export type ApprovalAppState =
  | {
      approvalToken: string;
      executionId: string;
      status: "pending";
    }
  | {
      executionId: string;
      status: "approved" | "denied" | "error";
      summary: string;
    };

// The `structuredContent` of both app-only tools: the server-rendered fragment
// the card injects, whether the run may still be approved, and the sentence a
// text-only reader is given. The card does no templating of its own — every
// value inside `html` was escaped by `approval-page.ts`.
export interface ApprovalCardView {
  canApprove: boolean;
  executionId: string;
  html: string;
  summary: string;
}

// The card loads nothing and connects nowhere: every byte it shows arrives
// over the host bridge. The allowlists are declared empty on purpose, and
// twice — once on the listing a host reviews at connection time and once on
// the contents it reads — so a host that sees only one still sees the same
// empty allowlist.
const CARD_CSP = {
  baseUriDomains: [],
  connectDomains: [],
  frameDomains: [],
  resourceDomains: [],
} satisfies Record<string, string[]>;

const CARD_META = { ui: { csp: CARD_CSP, prefersBorder: true } };

const CARD_STYLE = `${APPROVAL_STYLE}
body{padding:0;background:transparent}
main{padding:1.25rem;border-radius:10px}
h1{font-size:1.15rem}
p.actions{margin:1.25rem 0 0}
p.actions:empty{display:none}
button:disabled{cursor:not-allowed;opacity:.5}`;

// One self-contained document: no external stylesheet, no font, no script
// source, no image. The card's browser client is the official MCP Apps `App`
// client, written in `approval-card/client.ts` and bundled into
// `APPROVAL_CARD_SCRIPT` at build time, so nothing is fetched at render time
// and the allowlists above stay empty. `pnpm generate` rebuilds that bundle
// and `pnpm validate` fails while the committed copy is stale.
export const APPROVAL_APP_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(APPROVAL_APP_NAME)}</title><style>${CARD_STYLE}</style></head>
<body><main aria-live="polite"><div id="body">Loading the approval…</div>
<p class="actions" id="actions"></p></main>
<script>${APPROVAL_CARD_SCRIPT}</script></body></html>`;

export const registerApprovalAppResource = (server: McpServer): void => {
  for (const uri of [...LEGACY_APPROVAL_APP_URIS, APPROVAL_APP_URI]) {
    registerAppResource(
      server,
      APPROVAL_APP_NAME,
      uri,
      {
        _meta: CARD_META,
        description:
          "The inline card a host renders for a paused execute run: the same before/after preview and decision as the approval page.",
      },
      () => ({
        contents: [
          {
            _meta: CARD_META,
            mimeType: RESOURCE_MIME_TYPE,
            text: APPROVAL_APP_HTML,
            uri,
          },
        ],
      })
    );
  }
};
