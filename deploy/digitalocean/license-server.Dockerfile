# AirBridge license server for the DigitalOcean droplet (deploy/digitalocean). Built on the droplet by
# airbridge-bootstrap from the pinned commit. Build context: repository root.
ARG NODE_IMAGE=docker.io/library/node:22-slim@sha256:e9f565d32859f0cbfb52125eafe8be39390f24dac302dc3cdf566e8ba3ab21ee

FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY license-server/package.json license-server/package-lock.json ./
# Optional build secret `npmca` (a CA bundle) for builds behind a TLS-intercepting proxy; unused on the droplet.
RUN --mount=type=secret,id=npmca,required=false \
    if [ -s /run/secrets/npmca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/npmca npm_config_cafile=/run/secrets/npmca; fi; \
    npm ci --no-audit --no-fund
COPY license-server/tsconfig.json license-server/tsconfig.build.json ./
COPY license-server/src ./src
RUN npm run build && npm prune --omit=dev

FROM ${NODE_IMAGE}
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY license-server/package.json ./
COPY --chmod=0755 deploy/digitalocean/license-entrypoint.sh /usr/local/bin/license-entrypoint
USER node
EXPOSE 8787
ENTRYPOINT ["/usr/local/bin/license-entrypoint"]
