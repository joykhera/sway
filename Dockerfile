# syntax=docker/dockerfile:1
#
# Sway — multi-stage build for Render (Docker runtime).
#   deps    : pnpm install --frozen-lockfile (layer-cached on package.json + pnpm-lock.yaml)
#   build   : pnpm build → tsc --noEmit && vite build → /app/dist
#   runtime : node_modules + dist + server + src, non-root `node` user
#
# Server contract (docs/part-a-plan.md):
#   binds HOST (default 127.0.0.1) + PORT (default 8787); Render injects PORT.
#   serves dist/ static, upgrades /api/music WS, GET /healthz → 200 JSON.
#   `pnpm start` → `tsx --env-file-if-exists=.env server/index.ts`.

FROM node:22-bookworm-slim AS base
# COREPACK_HOME must be a world-readable path: corepack's default cache lives in
# the building user's home, which the non-root `node` user could not read at
# container start. prepare --activate pins pnpm@10.30.3 (repo's PM version).
ENV COREPACK_HOME=/opt/corepack
RUN corepack enable && corepack prepare pnpm@10.30.3 --activate
WORKDIR /app

# ---- deps: pinned install, cached until package.json/lockfile change ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---- build: typecheck + vite build ----
FROM deps AS build
COPY . .
RUN pnpm build
# /app/dist now exists (vite build output).

# ---- runtime ----
FROM base AS runtime
ENV NODE_ENV=production
ENV HOST=0.0.0.0
# tsx is a devDependency, so the full (dev-inclusive) node_modules ships to runtime —
# do NOT prune to --prod or `pnpm start` loses its runner. ~150–250 MB; fine for MVP.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
# Server imports src/shared/protocol.ts; whole src/ tree copied (~1 MB) so any
# additional src/ imports by server/ keep working without Dockerfile edits.
COPY --from=build /app/src ./src
USER node
# Render ignores EXPOSE and routes to the injected $PORT; 8787 documents the
# local default for `docker run -p 8787:8787`.
EXPOSE 8787
# If pnpm-via-corepack ever fails as non-root, equivalent fallback:
#   CMD ["node", "node_modules/tsx/dist/cli.mjs", "--env-file-if-exists=.env", "server/index.ts"]
CMD ["pnpm", "start"]
