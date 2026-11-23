# AirBridge cloud for Railway: Headscale v0.29.7 + license server + Caddy in one container.
# Build context: repository root (Railway: dockerfilePath deploy/railway/Dockerfile).
FROM headscale/headscale:v0.29.7 AS headscale
FROM caddy:2.10.2 AS caddy

FROM node:22-slim AS build
WORKDIR /app
COPY license-server/package.json license-server/package-lock.json ./
RUN npm ci
COPY license-server/tsconfig.json license-server/tsconfig.build.json ./
COPY license-server/src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production PORT=8080
COPY --from=headscale /ko-app/headscale /usr/local/bin/headscale
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
WORKDIR /app/license-server
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY license-server/package.json ./
# The policy is security-critical (PHASE3_SECURITY F-1): use the reviewed file byte-for-byte.
COPY license-server/headscale/policy.hujson /etc/headscale/policy.hujson
COPY deploy/railway/headscale.yaml.tmpl deploy/railway/Caddyfile /etc/airbridge/
COPY --chmod=0755 deploy/railway/entrypoint.sh /usr/local/bin/airbridge-entrypoint
# Runs as root only to prepare /data (Railway volumes are root-owned); every service drops to `node`.
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/airbridge-entrypoint"]
