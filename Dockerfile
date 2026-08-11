# Runs `sharedoc-mcp serve` — the standalone selfhost viewer daemon (no MCP client
# attached). The stdio MCP server itself isn't a Docker use case: it needs a local
# process wired to an MCP client's stdin/stdout, which a container can't provide.
#
# Multi-stage: compile TypeScript in a full image, ship only the runtime deps + dist/
# in a slim one.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=build /app/dist ./dist

# docs.db (selfhost SQLite) lives here — mount a volume so data survives a container
# recreate. SHAREDOC_DATA_DIR already defaults to a XDG-style user path outside a
# container; inside one there's no meaningful home dir to default to, so it's pinned
# explicitly here instead of relying on that fallback. Created + chowned before USER
# node below — a VOLUME's mountpoint inherits the image's ownership at creation time,
# and the container does not run as root.
ENV SHAREDOC_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data
VOLUME /data

# SECURITY: the viewer binds 127.0.0.1 ONLY by default — matching every other
# deployment of this project — which means unreachable from outside this container via
# `docker run -p`, on purpose. Opt in explicitly with:
#   -e SHAREDOC_BIND_HOST=0.0.0.0
# which makes the viewer answer on any interface it can see. Combine with -p to expose
# it, and set SHAREDOC_PUBLIC_URL to whatever address/domain you're actually reachable
# at (host port mapping, reverse proxy, tunnel) — the container cannot infer it. Without
# a reverse proxy/tunnel in front, this is depending on the container network's/firewall's
# access already being trusted the same way exposing any other unauthenticated app would be.
EXPOSE 8377

USER node
CMD ["node", "dist/index.js", "serve"]
