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

COPY package.json pnpm-lock.yaml ./
RUN corepack enable pnpm \
 && pnpm install --frozen-lockfile --prod --ignore-scripts \
 && pnpm rebuild better-sqlite3

# adapter-node bundles non-externalized deps into /app/build at build
# time. Looking at the build output's actual external imports, only
# these need to remain in node_modules at runtime:
#
#   @sveltejs/kit, svelte, arctic, better-sqlite3, drizzle-orm,
#   markdown-it, shiki, smol-toml, style-to-object, @standard-schema/spec
#
# Everything else (lucide-svelte's 7240 icon files at 42MB, bits-ui at
# 5MB + its floating-ui/runed/etc. deps, the entire vite/rolldown/
# typescript chain pulled in as peer deps) is build-time only or got
# inlined into the bundle. Removing them drops the runtime image from
# ~350MB to under 200MB.
RUN find /app/node_modules/.pnpm -mindepth 1 -maxdepth 1 -type d \
    \( -name 'typescript@*' \
       -o -name 'vite@*' \
       -o -name 'rolldown@*' \
       -o -name '@rolldown+*' \
       -o -name 'esbuild@*' \
       -o -name '@esbuild+*' \
       -o -name 'lightningcss@*' \
       -o -name 'lightningcss-*' \
       -o -name 'jiti@*' \
       -o -name 'terser@*' \
       -o -name 'tsx@*' \
       -o -name '@types+*' \
       -o -name 'lucide-svelte@*' \
       -o -name 'bits-ui@*' \
       -o -name '@internationalized+*' \
       -o -name '@floating-ui+*' \
       -o -name 'runed@*' \
       -o -name 'svelte-toolbelt@*' \
       -o -name 'tabbable@*' \
       -o -name '@swc+*' \
       -o -name '@vite-pwa+*' \
       -o -name 'workbox-*' \
    \) -exec rm -rf {} +


# --- runtime ----------------------------------------------------------
FROM node:24-alpine AS runtime

# tini = PID 1 with proper signal handling. Without it, SIGTERM doesn't
# reach the Node process cleanly, which means the media purger interval
# can leave a half-finished sweep on shutdown.
RUN apk add --no-cache tini

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

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
