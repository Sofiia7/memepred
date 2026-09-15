# Single image used for both `backend` (API) and `keeper` (worker) services.
#
# Built from the repo root (see docker-compose.yml's `context: ..`), not from
# backend/ alone: backend is a pnpm workspace member, and the root
# pnpm-lock.yaml is where the `ws`/`axios` security overrides in the root
# package.json's `pnpm.overrides` actually apply. The previous npm-based
# build resolved backend/package.json in isolation, so it got neither the
# workspace's locked versions nor those overrides - a rebuild could silently
# pull a different, un-patched dependency tree than `pnpm install` at the
# repo root gives everyone else. It also installed devDependencies straight
# into the runtime image, because `--omit=dev=false` is not a flag npm
# understands and was silently ignored.
FROM node:20-alpine AS build
WORKDIR /app

# Pin the same pnpm the rest of the project uses (root package.json's
# "packageManager", also CI's PNPM_VERSION) instead of whatever corepack
# would otherwise resolve.
RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

# Workspace manifests only, so this layer is cached until a dependency
# actually changes. pnpm needs every workspace member's package.json present
# to reconcile --frozen-lockfile against the root lockfile, even though only
# backend/ ends up built into this image.
COPY pnpm-workspace.yaml package.json pnpm-lock.yaml ./
COPY backend/package.json ./backend/package.json
COPY frontend/package.json ./frontend/package.json
COPY workers/package.json ./workers/package.json
RUN pnpm install --frozen-lockfile

COPY backend ./backend
RUN pnpm --filter ./backend run build

# Materialize backend's production-only dependencies as real files (pnpm's
# normal node_modules is a tree of symlinks into a shared store, which would
# dangle if copied alone into another stage) in their own directory - this is
# pnpm's documented way to hand one workspace package's deps to a separate
# Docker stage. `pnpm deploy` does not carry over gitignored build output
# such as dist/ (backend/package.json has no "files" field, so file
# selection falls back to .gitignore, which excludes dist/) - the runtime
# stage below copies dist/, package.json and migrations straight from this
# stage instead, and takes only node_modules from the deploy output.
RUN pnpm --filter ./backend --prod deploy /prod/backend

FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /prod/backend/node_modules ./node_modules
COPY --from=build --chown=node:node /app/backend/package.json ./package.json
COPY --from=build --chown=node:node /app/backend/dist ./dist
COPY --from=build --chown=node:node /app/backend/src/db/migrations ./dist/db/migrations
# node:20-alpine ships a built-in unprivileged `node` user (uid 1000) - both
# the backend and keeper services use this same image, neither needs root.
USER node
EXPOSE 3001
CMD ["node", "dist/index.js"]
