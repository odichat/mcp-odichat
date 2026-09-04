# syntax=docker/dockerfile:1

# Pinned to the Bun version used in development (see `bun --version`).
FROM oven/bun:1.3.13-slim

WORKDIR /app

# Install dependencies first to leverage Docker layer caching. Only the lockfile
# and manifest are needed, so source changes don't bust the dependency cache.
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Copy the application source. Bun runs TypeScript directly, so there is no
# separate build step for the server.
COPY tsconfig.json ./
COPY src ./src

# Run as the unprivileged `bun` user that ships with the base image.
USER bun

# Network transport: serve over HTTP via Bun.serve (see src/http.ts). SSL is
# terminated upstream (Traefik), so the app listens plain HTTP on PORT.
ENV MCP_TRANSPORT=http \
    PORT=3000 \
    NODE_ENV=production

EXPOSE 3000

ENTRYPOINT ["bun", "run", "src/index.ts"]
