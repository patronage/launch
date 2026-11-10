# @patronage/access

## 0.2.0

### Minor Changes

- Cloudflare list endpoints are read page by page. `CloudflareClient` has a new `list` method, and `ensurePolicy` and `ensureApplication` use it, so a policy or application past the first page is updated instead of created again. Paging follows `total_pages`, else `total_count`, else a full page (`LIST_PAGE_SIZE`). A custom `CloudflareClient` must now implement `list`.

## 0.1.0

### Minor Changes

- First npm release (2026-11-03): verify Access JWTs, call Access-protected origins with a service token, bind forwarded JWTs with a gateway proof, an Access auth strategy for Payload (`@patronage/access/payload`), and Access provisioning through the Cloudflare API (`@patronage/access/cloudflare`).
