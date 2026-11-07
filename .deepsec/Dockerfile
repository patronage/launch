FROM node:24-bookworm-slim@sha256:c86ecead9e55a5210ac1727de38a4ca840bf03dcaf34dc9749addbf383b1920c

WORKDIR /scanner
RUN corepack enable && corepack prepare pnpm@12.16.1 --activate
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile --prod --ignore-scripts
COPY deepsec.config.ts INFO.md matchers.mjs ./
RUN apt-get update \
  && apt-get install --yes --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN mkdir /scanner/data && chown 65532:65532 /scanner/data
USER 65532:65532
ENTRYPOINT ["node", "/scanner/node_modules/deepsec/dist/cli.mjs"]
