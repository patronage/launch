---
"@patronage/access": minor
---

Adds `verifyForwardedUser` and `hasForwardedJwt`, for a CMS that trusts the Access JWT a gateway forwards in `X-Access-User-Jwt`: the gateway proof must verify before the JWT is checked, and a service token's identity is refused.
