# @patronage/access

Cloudflare Access helpers for Workers and Node. See `docs/spikes/05-access-lockdown.md` for the pattern they implement.

| Export | Use |
| --- | --- |
| `verifyAccessJwt`, `verifyAccessRequest` | Verify an Access JWT (RS256, exact issuer, audience, `exp`/`nbf` with 60s leeway). Returns a `user` identity (email) or a `service` identity (service token `common_name`). |
| `accessFetch`, `accessRequestHeaders` | Call an origin behind Access with a service token, optionally forwarding a user's JWT as `X-Access-User-Jwt` with a gateway proof. Redirects are not followed, and `isAccessRejection` spots an Access login redirect. |
| `computeGatewayProof`, `verifyGatewayProof` | HMAC proof binding a forwarded JWT to the gateway; same format as the WordPress plugin. |
| `@patronage/access/payload` → `accessAuthStrategy` | Payload custom auth strategy mapping the Access login's email to a user. No Payload dependency. |
| `@patronage/access/cloudflare` → `provisionLockdown` | Create or update an Access application, its policies and service tokens through the Cloudflare API, by name. |

## Provision Access

```bash
CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... \
  pnpm --filter @patronage/access access:provision \
  --name "Demo WordPress" --destination cms.example.org \
  --allow-email-domain example.org --service-token "demo web worker" --dry-run
```

Repeat `--destination host/path` to protect only some paths (Payload: `/admin` and `/api`). The API token needs Access: Apps and Policies Edit and Access: Service Tokens Edit. The script prints the team domain, the AUD and, for a newly created service token, its secret, which Cloudflare shows only once.
