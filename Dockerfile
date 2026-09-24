# syntax=docker/dockerfile:1.27

# ----------------------------------------------------------------------
# GlyphStream — multi-stage Alpine build.
#
# Five stages:
#   1. builder   — full deps; produces /app/build.
#   2. proddeps  — fresh install of *only* production deps. Parallel
#                  to builder; doesn't see source. Avoids the trap
#                  where `pnpm prune --prod` leaves orphans behind in
#                  .pnpm/ that the runtime would still ship.
#   3. ffmpeg    — compiles a decode-only ffmpeg. Discarded; the runtime
#                  copies one 5 MB binary out of it.
#   4. runtime-base — node:26-alpine + our OS packages, with what a server
#                  never reads trimmed out (debug info, headers, docs).
#   5. runtime   — runtime-base copied into `scratch` (so the trim actually
#                  shrinks the image) + ffmpeg + just the artifacts. No compilers.
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
# what this needs. Measured on linux/amd64 against the same base, this stage
# costs ~5 MB (a 4.8 MB stripped binary) where `apk add ffmpeg` and a prebuilt
# static binary each cost upwards of 130 MB — roughly 25-30x more.
#
# Stated as a ratio on purpose. Absolute deltas were in here and went stale
# within weeks: they move with every base-image and package refresh, and the
# figure that matters is the order of magnitude, not the megabyte.
#
# `--disable-autodetect` is what buys most of that: without it, configure links
# every codec library it finds sitting in the build stage — x264, x265, and the
# rest — none of which we want, because this build never ENCODES video. It
# decodes one frame and writes one JPEG, and it re-wraps an existing bitstream
# into a new container without touching it.
#
# That second job is why the mp4/mov/matroska/webm muxers are enabled (+188 KB). A
# faststart remux is `-c copy`: the demuxer reads the bitstream and the muxer
# writes it back out with the index moved to the front, and nothing decodes.
# See media/faststart.ts for why that matters. The added surface is a muxer
# rather than a decoder, which is the safer half of the pair — but it is worth
# saying plainly that "decode-only" is now "decode and re-wrap".
#
# The narrow codec set is also a security property, not just a size one. A video
# decoder is a well-known source of memory-safety CVEs, and this path feeds it
# arbitrary user-uploaded files (classifyUpload accepts any `video/*`). Six
# decoders is a smaller surface to keep patched than the several hundred the
# distro package ships. What is enabled covers what actually reaches us:
# h264 for generated video, hevc for iPhone uploads (its camera default since
# iOS 11), vp8/vp9 for webm, mjpeg for older cameras, and the mov demuxer for
# .mp4 and .mov alike.
#
# AV1 comes from libdav1d, NOT from ffmpeg's built-in `av1` decoder. That one is
# a hwaccel-only wrapper: it builds and it lists in `-decoders`, and then every
# software decode fails with "Your platform doesn't support hardware accelerated
# AV1 decoding". Enabling it here bought exactly nothing and read as coverage —
# which is why the runtime-base stage installs libdav1d rather than the decoder list
# simply naming `av1`. libdav1d ships shared-only on Alpine, so it is apk-managed
# on both sides instead of copied; that also keeps it picking up CVE fixes when
# the base image is rebased, which for a decoder is the point.
#
# Cold build is ~30s — configure skips probing everything that's disabled, and
# make compiles a few dozen files instead of thousands.
# Same base as the runtime-base stage, deliberately. libdav1d is the one library this
# binary links dynamically, and it is apk-installed on BOTH sides — so if the two
# stages sat on different Alpine snapshots, a dav1d SONAME bump (libdav1d.so.7 ->
# .so.8) in whichever one moved first would leave a binary that cannot exec. That
# failure is silent by construction: a missing/unloadable ffmpeg is just another
# decode failure, so the symptom would be every video tile in every deployment
# going blank after an unrelated base-image refresh, with a green build.
FROM node:26-alpine AS ffmpeg
# Bump these two together. The digest is what makes the version a pin rather
# than a label — without it, `9.0.1` means "whatever that URL serves today".
ARG FFMPEG_VERSION=9.0.1
ARG FFMPEG_SHA256=cf38e0e28c7e5605942c4a77755349b0145804a397af37eb1fb4c77cb237f635
RUN apk add --no-cache build-base nasm yasm tar xz wget pkgconf dav1d-dev
WORKDIR /src
# What this check is: the digest makes the artifact immutable — a corrupted
# transfer, a mirror serving something else, or a re-rolled release all fail
# the build instead of being compiled into an image that decodes arbitrary
# uploads. Origin is verified once, when bumping, not on every build: the 9.0.1
# digest was recorded only after its detached `.asc` checked out against
# FFmpeg's release signing key, fingerprint
# FCF9 86EA 15E6 E293 A564 4F10 B432 2F04 D676 58D8 (matching ffmpeg.org's
# download page and keys.openpgp.org). Do the same on the next bump:
#   gpg --import ffmpeg-devel.asc   # from ffmpeg.org; check the fingerprint
#   gpg --verify ffmpeg-X.Y.Z.tar.xz.asc ffmpeg-X.Y.Z.tar.xz && sha256sum ffmpeg-X.Y.Z.tar.xz
# (pipefail-safe as is: the pipe ends in sha256sum -c, whose status is the check.)
# hadolint ignore=DL4006
RUN wget -qO ffmpeg.tar.xz "https://ffmpeg.org/releases/ffmpeg-${FFMPEG_VERSION}.tar.xz" \
    && echo "${FFMPEG_SHA256}  ffmpeg.tar.xz" | sha256sum -c - \
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
      --enable-libdav1d \
      --enable-decoder=h264,hevc,vp8,vp9,libdav1d,mjpeg \
      --enable-parser=h264,hevc,vp8,vp9,av1,mjpeg \
      --enable-demuxer=mov,matroska \
      --enable-encoder=mjpeg \
      --enable-muxer=image2,mp4,mov,matroska,webm \
      --enable-filter=scale,format,null,copy \
      --enable-protocol=file \
      --enable-swscale \
    && make -j"$(nproc)" \
    && make install \
    && strip /opt/ff/bin/ffmpeg

# Prove the whole pipeline, not just that it compiled. `-decoders` (checked in
# the runtime stage) covers the link; this covers the half --disable-everything
# is most likely to strip by accident — the mjpeg encoder, the image2 muxer, the
# scale filter, the file protocol on the output side — by running the exact
# argument list from media/thumbnail.ts against a real h264 mp4.
#
# The ROTATED sample is not redundant. ffmpeg applies a display matrix by
# INSERTING transpose/hflip/vflip into the filtergraph, and this build names
# none of them in --enable-filter — so it looks, repeatedly and convincingly, like
# every phone-shot video must fail here. It doesn't: configure's `ffmpeg_select`
# force-enables those filters for the CLI after --disable-everything. Three
# separate reviewers chased that reading; this probe answers it in the build log
# rather than in someone's afternoon.
#
# The distro ffmpeg is here only to MAKE the samples, and this whole stage is
# discarded, so it costs the shipped image nothing. Without it a future edit to
# --enable-filter or --enable-muxer would build green and blank every video tile
# in production, where a broken ffmpeg and an undecodable file look identical.
#
# Both argv shapes the app actually runs are exercised, because they fail
# differently and both fail SILENTLY. The thumbnail pipeline needs the filters
# and the mjpeg encoder; the faststart remux needs the mp4 muxer, and its
# failure surfaces as null -> keep the original -> videos that simply never get
# faststart, with nothing logged. The remux probe asserts three things rather
# than just an exit code: the output exists, all three input streams survived
# (a default stream selection would silently drop one, so this pins the -map
# pair too), and the box immediately after `ftyp` really is `moov`, which is the
# entire point of the exercise. That last offset is read out of ftyp's own size
# field rather than hardcoded — the length ffmpeg writes there is a detail of
# its version, and a probe that asserts a constant would start failing on an
# upgrade for a reason that has nothing to do with what it is testing.
# (The one pipe feeds `wc -l` into a `test` that fails unless it counts 3; `set -- $(od …)` splits on purpose.)
# hadolint ignore=DL4006,SC2046
RUN apk add --no-cache ffmpeg \
    && ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=320x240:rate=30 \
         -frames:v 3 -c:v libx264 -y /tmp/probe.mp4 \
    && ffmpeg -hide_banner -loglevel error -display_rotation 90 -i /tmp/probe.mp4 \
         -c copy -y /tmp/probe-rot.mp4 \
    && for f in probe probe-rot; do \
         /opt/ff/bin/ffmpeg -hide_banner -loglevel error -nostdin -threads 1 \
           -max_pixels 33177600 -protocol_whitelist file -ss 0 -i /tmp/$f.mp4 -frames:v 1 \
           -vf "scale=w='min(512,iw)':h='min(512,ih)':force_original_aspect_ratio=decrease" \
           -q:v 8 -f image2 -y /tmp/$f.jpg \
         && test -s /tmp/$f.jpg || exit 1; \
       done \
    && ffmpeg -hide_banner -loglevel error -f lavfi -i testsrc=size=320x240:rate=15:d=1 \
         -f lavfi -i sine=frequency=440:duration=1 -f lavfi -i sine=frequency=880:duration=1 \
         -map 0:v -map 1:a -map 2:a -c:v libx264 -pix_fmt yuv420p -c:a aac \
         -y /tmp/probe-multi.mp4 \
    && /opt/ff/bin/ffmpeg -hide_banner -loglevel error -nostdin -protocol_whitelist file \
         -i /tmp/probe-multi.mp4 -map 0 -map -0:d -c copy -movflags +faststart \
         -f mp4 -y /tmp/probe-fs.mp4 \
    && test -s /tmp/probe-fs.mp4 \
    && test $(( $(ffprobe -v error -show_entries stream=index -of csv=p=0 /tmp/probe-fs.mp4 | wc -l) )) -eq 3 \
    && set -- $(od -An -tu1 -N4 -j0 /tmp/probe-fs.mp4) \
    && test "$(dd if=/tmp/probe-fs.mp4 bs=1 \
         skip=$(( $1*16777216 + $2*65536 + $3*256 + $4 + 4 )) count=4 2>/dev/null)" = moov

# --- runtime-base -----------------------------------------------------
# The runtime's operating system: node:26-alpine plus our packages, minus what
# a running server never touches. The runtime stage below copies this whole
# filesystem into `scratch` rather than building FROM it, and that is the only
# way the trimming can shrink anything: an image FROM node:26-alpine carries the
# base layer's bytes whatever a later layer deletes. About 35 MB comes off the
# unpacked image this way (see the trim step below for where it goes).
#
# Why not `FROM alpine` plus a copied node binary, which gets the same bytes:
# the Alpine version would then be pinned here instead of following Node's. The
# node binary links the base's libstdc++, the ffmpeg stage's libdav1d must match
# this one's (see there), and a pinned `alpine:3.x` would be bumped by Renovate
# on a different schedule from `node:26-alpine` — as a minor, which automerges.
# Deriving from node:26-alpine keeps one moving part, exactly as before.
FROM node:26-alpine AS runtime-base

# tini = PID 1 with proper signal handling. Without it, SIGTERM doesn't
# reach the Node process cleanly, which means the media purger interval
# can leave a half-finished sweep on shutdown.
#
# sqlite3 CLI is included for operational queries — finding a user id
# before running the OWUI importer, eyeballing media row counts, etc.
# ~2MB additional, worth it for "I can poke at the DB without exec'ing
# into a separate container."
#
# `apk upgrade` first: node:26-alpine is rebuilt when Node releases, on top of
# an alpine:3.24 image that Alpine itself only republishes for point releases,
# so the base routinely ships packages the 3.24 repo has already patched (e.g.
# libssl3/libcrypto3 3.5.7 when 3.5.8 was out). The app doesn't link them —
# the official node binary bundles its own OpenSSL, and tini, sqlite3, libdav1d
# and our ffmpeg don't either; apk-tools and busybox's ssl_client do — but the
# image scan reports them, and a stale package is a stale package. The layer
# cache can hold an older upgrade until the base image changes; the weekly
# image-scan.yml run is what notices.
#
# libdav1d is for our ffmpeg (copied in by the runtime stage): the one codec
# library it links against rather than implements — ffmpeg's own AV1 decoder
# cannot decode in software.
#
# Then the trim. None of it is read by a running server:
#   - the node binary's symbol table and DWARF debug info (~15 MB). The official
#     build ships unstripped. JS stack traces are unaffected; what is lost is
#     symbol names in a native crash backtrace, which nobody reads off a
#     production image.
#   - Node's C headers (~6.5 MB), there for compiling native addons, and this
#     image has no compiler to compile one with.
#   - npm's docs and man pages (~3 MB), read only by `npm help`.
#   - the base's docker-entrypoint.sh, which tini replaces as ENTRYPOINT.
#
# npm and npx themselves STAY. The documented stdio MCP setup is
# `command = "npx"` (docs/mcp.md), spawned inside this container, so removing
# them would break every MCP server configured that way — for 16 MB.
RUN apk upgrade --no-cache \
 && apk add --no-cache tini sqlite libdav1d \
 && apk add --no-cache --virtual .strip binutils \
 && strip /usr/local/bin/node \
 && apk del .strip \
 && rm -rf /usr/local/include \
           /usr/local/lib/node_modules/npm/docs \
           /usr/local/lib/node_modules/npm/man \
           /usr/local/share/doc /usr/local/share/man \
           /usr/local/bin/docker-entrypoint.sh


# --- runtime ----------------------------------------------------------
FROM scratch AS runtime

# Copying a whole filesystem is what DL3067 exists to catch, and here it is the
# point: see runtime-base for why the trim can only land this way.
# hadolint ignore=DL3067
COPY --from=runtime-base / /
# `scratch` inherits none of the base's config, so restate what it set that the
# server relies on: PATH (for `node`, `ffmpeg`, and npx's child processes).
ENV PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

# Decode-and-remux, ~5 MB. See the ffmpeg stage for why it isn't
# `apk add ffmpeg`, and for why "decode-only" stopped being the right word.
COPY --from=ffmpeg /opt/ff/bin/ffmpeg /usr/local/bin/ffmpeg
# Prove the copied binary execs and resolved libdav1d. The end-to-end pipeline is
# proved in the ffmpeg stage instead, where a throwaway full ffmpeg can generate
# a sample to decode; here there is nothing to decode and no way to synthesize
# one, since `lavfi` is exactly the sort of surface --disable-everything strips
# and enabling it to satisfy a test would defeat the point of the stage.
# (No pipefail here on purpose: grep -q exits at the first match, and ffmpeg
# can then take SIGPIPE — pipefail would turn a pass into a flaky failure.)
# hadolint ignore=DL4006
RUN ffmpeg -hide_banner -decoders | grep -q libdav1d

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
