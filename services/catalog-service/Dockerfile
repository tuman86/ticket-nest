# syntax=docker/dockerfile:1
# Build from the repository root so the workspace packages are in the context:
#   docker build -f services/catalog-service/Dockerfile -t ticketnest/catalog-service .

# ---- build: install the service and its workspace packages, bundle to one file ----
FROM node:24-alpine AS build
ENV HUSKY=0 CI=true
RUN corepack enable
WORKDIR /repo

# Download dependencies from the lockfile alone, so this layer is reused until it changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm fetch

COPY . .
RUN pnpm install --offline --frozen-lockfile --filter @ticketnest/catalog-service...
RUN pnpm --filter @ticketnest/catalog-service build

# ---- runtime: bare Alpine, the Node binary and one bundled file ----
# Copying only the binary leaves out npm, yarn and corepack (about 25 MB the service never uses,
# and tools an attacker could use). Deleting them in a later layer would not shrink the image.
FROM alpine:3.22 AS runtime
RUN apk add --no-cache libstdc++ \
    && addgroup -S -g 10001 app \
    && adduser -S -u 10001 -G app app
COPY --from=build /usr/local/bin/node /usr/local/bin/node
ENV NODE_ENV=production \
    PORT=4002
WORKDIR /app
COPY --from=build --chown=app:app /repo/services/catalog-service/dist/server.cjs ./server.cjs

USER app
EXPOSE 4002
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch(`http://127.0.0.1:${process.env.PORT}/health/live`).then((response) => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]
CMD ["node", "server.cjs"]
