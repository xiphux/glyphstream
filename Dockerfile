# syntax=docker/dockerfile:1.7

# ----------------------------------------------------------------------
# GlyphStream — multi-stage Alpine build.
#
# Three stages:
#   1. builder   — full deps + native toolchain; produces /app/build.
#   2. proddeps  — fresh install of *only* production deps. Parallel
#                  to builder; doesn't see source. Avoids the trap
#                  where `pnpm prune --prod` leaves orphans behind in
#                  .pnpm/ that the runtime would still ship.
#   3. runtime   — node + tini + just the artifacts. No compilers.
#
# better-sqlite3 doesn't ship a musl-compatible prebuilt binary, so
# both builder + proddeps stages compile it from source. The runtime
# stage only carries the resulting .node binary.
# ----------------------------------------------------------------------

# --- builder ----------------------------------------------------------
FROM node:24-alpine AS builder

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Copy lockfile first so cache invalidates only on dep changes.
# --ignore-scripts skips lifecycle hooks here (the `prepare` script
# needs svelte.config.js, which we haven't copied yet, and pnpm 10
# blocks unapproved native-module builds in non-interactive contexts).
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm \
 && pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# Compile native modules now that scripts can run, sync svelte-kit's
# generated files, then build the app.
RUN pnpm rebuild better-sqlite3 esbuild \
 && pnpm svelte-kit sync \
 && pnpm build


# --- proddeps ---------------------------------------------------------
FROM node:24-alpine AS proddeps

RUN apk add --no-cache python3 make g++

WORKDIR /app

# Install ONLY production deps. Because lucide-svelte and bits-ui are
# devDependencies (their components are fully bundled into the build
# output by Vite), this also avoids the chain of transitive peer-deps
# they would have pulled in (typescript via runed→kit, vite/rolldown
# via kit, lightningcss via tailwind, etc). The result is a much
# leaner /app/node_modules without needing a manual trim list.
COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm \
 && pnpm install --frozen-lockfile --prod --ignore-scripts \
 && pnpm rebuild better-sqlite3


# --- runtime ----------------------------------------------------------
FROM node:24-alpine AS runtime

# tini = PID 1 with proper signal handling. Without it, SIGTERM doesn't
# reach the Node process cleanly, which means the media purger interval
# can leave a half-finished sweep on shutdown.
#
# sqlite3 CLI is included for operational queries — finding a user id
# before running the OWUI importer, eyeballing media row counts, etc.
# ~2MB additional, worth it for "I can poke at the DB without exec'ing
# into a separate container."
RUN apk add --no-cache tini sqlite

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000 \
    # SvelteKit adapter-node's request body cap defaults to 512KB —
    # way too low for image uploads. 25 MiB matches /api/uploads' own
    # cap with headroom for multipart-form overhead. User can override
    # via .env or compose environment if they want.
    BODY_SIZE_LIMIT=26214400

# Just the built app + production node_modules. No compilers, no source.
COPY --from=builder /app/build ./build
COPY --from=builder /app/drizzle ./drizzle
COPY --from=proddeps /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# `data/` (sqlite + media) is expected to be a bind mount or named
# volume; the dir is created on first DB open if missing.
EXPOSE 3000
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js"]
