# tasks, TypeScript build (ADR-0001, Image). Build context: this app/ directory.
#
#   docker build -t tasks-ts:local app/
#
# Runs the Nitro server by default. The migrate entrypoint runs from the same
# image as an init container or Job, with args ["entrypoints/migrate.js"].

# --- build: install with the pinned Bun, then vite build + bundled entrypoints
FROM oven/bun:1.4.3 AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

# --- runtime: distroless Bun, non-root, only the build output
FROM oven/bun:1.4.3-distroless
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    MIGRATIONS_DIR=/app/drizzle
COPY --from=build /src/.output/ ./
COPY --from=build /src/drizzle/ ./drizzle/
USER 10001:10001
EXPOSE 3000
CMD ["run", "server/index.mjs"]
