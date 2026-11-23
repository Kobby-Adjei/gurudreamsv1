# AirBridge cloud for Railway: license server + static landing page behind Caddy, in one container.
# Headscale is NOT part of this image: Railway's edge strips non-WebSocket Upgrade headers, which breaks
# Tailscale's /ts2021 control protocol and DERP (see README.md). The self-hosted kit stays in license-server/headscale/.
# Build context: repository root (Railway: dockerfilePath deploy/railway/Dockerfile).
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
COPY --from=caddy /usr/bin/caddy /usr/local/bin/caddy
WORKDIR /app/license-server
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY license-server/package.json ./
# Static landing page (built by UI/UX as plain files; served read-only by Caddy).
COPY landing/ /srv/landing/
RUN chmod -R a+rX,go-w /srv/landing && test -f /srv/landing/index.html
COPY deploy/railway/Caddyfile /etc/airbridge/
COPY --chmod=0755 deploy/railway/entrypoint.sh /usr/local/bin/airbridge-entrypoint
# Runs as root only to prepare /data (Railway volumes are root-owned); every service drops to `node`.
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/airbridge-entrypoint"]
