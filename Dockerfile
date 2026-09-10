# syntax=docker/dockerfile:1.7

# ----------------------------------------------------------------------
# GlyphStream — multi-stage Alpine build.
#
# Four stages:
#   1. builder   — full deps; produces /app/build.
#   2. proddeps  — fresh install of *only* production deps. Parallel
#                  to builder; doesn't see source. Avoids the trap
#                  where `pnpm prune --prod` leaves orphans behind in
#                  .pnpm/ that the runtime would still ship.
#   3. ffmpeg    — compiles a decode-only ffmpeg. Discarded; the runtime
#                  copies one 5 MB binary out of it.
#   4. runtime   — node + tini + ffmpeg + just the artifacts. No compilers.
#
# No JavaScript dependency needs a C/C++ toolchain: SQLite is the built-in
# `node:sqlite` and sharp ships prebuilt musl binaries. The only build-script
# package is esbuild (prebuilt Go binary, fetched not compiled), rebuilt
# explicitly because install runs with --ignore-scripts. The ffmpeg stage is
# the one place a compiler appears, and nothing it installs reaches runtime.
# ----------------------------------------------------------------------

# --- builder ----------------------------------------------------------
FROM node:26-alpine AS builder

WORKDIR /app

# Copy lockfile first so cache invalidates only on dep changes.
# --ignore-scripts skips lifecycle hooks here (the `prepare` script
# needs svelte.config.js, which we haven't copied yet, and pnpm
# blocks unapproved native-module builds in non-interactive contexts).
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# node:alpine stopped bundling corepack as of Node 26, so install pnpm
# directly. Read the version from package.json's `packageManager` field
# (the same field corepack consults) so the Dockerfile stays in sync
# with the rest of the toolchain without a second pin to maintain.
RUN npm install -g "$(node -p "require('./package.json').packageManager")" \
 && pnpm install --frozen-lockfile --ignore-scripts

COPY . .

# Run esbuild's install script (skipped above by --ignore-scripts) to
# fetch its prebuilt binary, sync svelte-kit's generated files, then
# build the app.
RUN pnpm rebuild esbuild \
 && pnpm svelte-kit sync \
 && pnpm build \
 # Strip SSR source maps (~3 MB) from the shipped artifact. SvelteKit's
 # adapter-node emits a `.map` per server chunk regardless of Vite's
 # build.sourcemap; they're never served to a client and only map traces
 # back to the (unminified) bundled output, so they're dead weight in the
 # image. Done here, not in `pnpm build`, so local builds keep them.
 && find build/server -name '*.map' -delete


# --- proddeps ---------------------------------------------------------
FROM node:26-alpine AS proddeps

WORKDIR /app

# Install ONLY production deps. Because @lucide/svelte and bits-ui are
# devDependencies (their components are fully bundled into the build
# output by Vite), this also avoids the chain of transitive peer-deps
# they would have pulled in (typescript via runed→kit, vite/rolldown
# via kit, lightningcss via tailwind, etc). The result is a much
# leaner /app/node_modules without needing a manual trim list.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# No --ignore-scripts follow-up rebuild needed: the only prod dep with a
# native component is sharp, which ships prebuilt musl binaries (no build
# script), and SQLite is the built-in node:sqlite.
RUN npm install -g "$(node -p "require('./package.json').packageManager")" \
 && pnpm install --frozen-lockfile --prod --ignore-scripts \
 # Strip declaration files and source maps — ~26 MB off the image
 # (307 -> 281 MB), a large chunk of it drizzle-orm shipping every
 # dialect's types + maps. Nothing reads either at runtime: types are a
 # compile-time artifact and the server is only ever run from the
 # pre-built bundle. Same reasoning as the builder stage's
 # `find build/server -name '*.map' -delete`, applied to node_modules.
 # Done in this RUN, not the runtime stage, so the layer itself is
 # smaller rather than shadowing files in an earlier one.
 && find node_modules -type f \
      \( -name '*.d.ts' -o -name '*.d.cts' -o -name '*.d.mts' -o -name '*.map' \) \
      -delete


# --- ffmpeg -----------------------------------------------------------
# A decode-only ffmpeg for gallery video thumbnails (see media/thumbnail.ts).
#
# Built rather than installed because the packaged builds are enormous next to
# what this needs. Measured on linux/amd64 against the same node:26-alpine base:
#
#   apk add ffmpeg                        +185 MB
#   prebuilt static binary (mwader)       +198 MB
#   this stage                            +5 MB   (4.8 MB stripped binary)
#
# `--disable-autodetect` is what buys most of that: without it, configure links
# every codec library it finds sitting in the build stage — x264, x265, and the
# rest — none of which we want, because this build never ENCODES video. It
# decodes one frame and writes one JPEG.
#
# The narrow codec set is also a security property, not just a size one. A video
# decoder is a well-known source of memory-safety CVEs, and this path feeds it
# arbitrary user-uploaded files (classifyUpload accepts any `video/*`). Six
# decoders is a smaller surface to keep patched than the several hundred the
# distro package ships. What is enabled covers what actually reaches us:
# h264 for generated video, hevc for iPhone uploads (its camera default since
# iOS 11), vp8/vp9/av1 for webm, and the mov demuxer for .mp4 and .mov alike.
#
# Cold build is ~30s — configure skips probing everything that's disabled, and
# make compiles a few dozen files instead of thousands.
FROM alpine:3.22 AS ffmpeg
ARG FFMPEG_VERSION=7.1.1
RUN apk add --no-cache build-base nasm yasm tar xz wget
WORKDIR /src
RUN wget -qO ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && tar xf ffmpeg.tar.xz --strip-components=1 \
    && rm ffmpeg.tar.xz
RUN ./configure \
      --prefix=/opt/ff \
      --disable-everything \
      --disable-autodetect \
      --disable-network \
      --disable-doc \
      --disable-ffplay \
      --disable-ffprobe \
      --disable-debug \
      --disable-shared \
      --enable-static \
      --enable-small \
      --enable-decoder=h264,hevc,vp8,vp9,av1,mjpeg,png \
      --enable-parser=h264,hevc,vp8,vp9,av1,mjpeg,png \
      --enable-demuxer=mov,matroska \
      --enable-encoder=mjpeg \
      --enable-muxer=image2 \
      --enable-filter=scale,format,null,copy \
      --enable-protocol=file \
      --enable-swscale \
    && make -j"$(nproc)" \
    && make install \
    && strip /opt/ff/bin/ffmpeg

# --- runtime ----------------------------------------------------------
FROM node:26-alpine AS runtime

# tini = PID 1 with proper signal handling. Without it, SIGTERM doesn't
# reach the Node process cleanly, which means the media purger interval
# can leave a half-finished sweep on shutdown.
#
# sqlite3 CLI is included for operational queries — finding a user id
# before running the OWUI importer, eyeballing media row counts, etc.
# ~2MB additional, worth it for "I can poke at the DB without exec'ing
# into a separate container."
RUN apk add --no-cache tini sqlite

# Decode-only, ~5 MB. See the ffmpeg stage for why it isn't `apk add ffmpeg`.
COPY --from=ffmpeg /opt/ff/bin/ffmpeg /usr/local/bin/ffmpeg

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

# Baked into the image so every consumer — compose, plain `docker run`,
# orchestrators — inherits it without redefining a healthcheck of their
# own. Hits /api/health on whatever PORT the app listens on (the slim
# runtime has no curl/wget, so we use Node's built-in fetch).
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "build/index.js"]
