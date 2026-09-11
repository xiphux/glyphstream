# Deployment

## Docker

Multi-stage Alpine Docker image, ~260 MB uncompressed (linux/amd64). Bind-mount `data/` for
persistence and mount `config.toml` read-only.

The image carries a small **decode-and-remux ffmpeg** (~5 MB), built by its own
stage rather than installed, and used for two things: extracting a frame for a
video's gallery thumbnail, and re-wrapping a stored mp4 so its index sits at
the front. It decodes H.264, HEVC, VP8, VP9, AV1 and MJPEG in MP4/MOV and
WebM/MKV containers — anything else stores fine and simply gets no thumbnail.
It cannot **encode** video at all: the re-wrap is a stream copy, which is why
adding it cost about 188 KB rather than pulling in x264 and the rest.

It is a runtime dependency of those paths only, but if you run the built output
outside this image and `ffmpeg` isn't on `PATH`, be clear about what you lose.
First: **every video renders as an empty box until you press play** — gallery
tiles, chat messages, tool-call attachments, and the lightbox alike. Not "a
slightly worse frame": those surfaces rely on the poster now and mostly no
longer ask the browser to fetch a frame of their own, so there is little
client-side fallback behind it. Second, and quietly: **new videos keep their
index at the end**, so playback over a slow link waits for most of the file
before it starts. That one surfaces no error anywhere — the video is intact and
plays correctly, just late — so if remote playback feels like it buffers
forever, check that `ffmpeg` is on `PATH` before looking anywhere else. Images,
uploads, and playback once started are unaffected. **Put `data/` on an SSD if you
have one** — SQLite reads are synchronous, so every one that misses the page
cache blocks the whole process for the length of the physical read, and on
spinning disks that is the dominant cost of a cold load. Never put the
_database_ on an NFS/SMB share: SQLite's locking is unreliable over network
filesystems, and GlyphStream memory-maps the database (see `PRAGMA mmap_size`
in `src/lib/server/db/client.ts`), which is unreliable over them too. Media is
a different question — see [Splitting storage across
volumes](#splitting-storage-across-volumes) below.

```bash
mkdir -p /srv/glyphstream/{data,imports}
cd /srv/glyphstream
cp /path/to/repo/.env.example .env       # then edit
cp /path/to/repo/config.toml.example config.toml  # then edit
cp /path/to/repo/docker-compose.yml .
docker compose up -d --build
curl http://localhost:3000/api/health
curl -s http://localhost:3000/setup > /dev/null   # mints the setup token
docker compose logs | grep '\[setup\]'           # one-time /setup?token=… URL
```

First-run setup requires that token — see the
[authentication guide](authentication.md) — so an instance that's reachable
before you finish setting it up can't be claimed by someone else.

The token is minted by the `/setup` gate on the first request that reaches it,
not at startup — which is why the `curl` above comes before the `grep`.
Opening the app in a browser does the same thing.

**Set `EXTERNAL_BASE_URL` in `.env` before the first `docker compose up`.**
With passkeys enabled (the default) the server refuses to start in production
while it's still the `.env.example` value `http://localhost:5173` — the
WebAuthn RP ID derives from it — so you'd get a crash loop rather than a setup
link. Once it's set, you can still reach the instance through some other origin
(`localhost:3000` before the proxy is up, say); the printed link will carry the
configured host, and substituting the one you're actually using is fine — the
token is correct either way.

Drizzle migrations apply automatically on first DB open. Subsequent config
or env changes only need `docker compose restart` — no rebuild.

## Faststart backfill (one-shot)

Videos are stored with their index at the front so a player can start before
the whole file arrives — see `src/lib/server/media/faststart.ts`. That happens
at write time, so anything generated from this release on is already correct.
Videos stored **before** it need one pass:

```bash
docker compose exec glyphstream node /app/build/scripts/faststart-backfill.js --dry-run
docker compose exec glyphstream node /app/build/scripts/faststart-backfill.js
```

It reads `DB_PATH` and `MEDIA_DIR`, rewrites only the files that need it, and
leaves anything it can't parse as an mp4 (WebM and friends) untouched. It needs
`ffmpeg` on `PATH` for the same reason the write-time path does.

It covers **generated** media only — the same scope as the write-time path.
Videos a user uploaded are left exactly as they arrived, on the principle that
a maintenance script shouldn't rewrite the only copy of a file someone handed
us.

**Safe to run repeatedly, by design.** Every run re-derives the answer for every
video rather than tracking progress, so an interrupted run is repaired by
running it again, and there's no resume state to lose. You can also re-run it
later purely to verify.

**Run it when nobody is watching.** "Safe to re-run" is about the script's own
state, not about clients. Moving the index shifts every sample offset in the
file, and the rewrite is a rename under a live server, so anyone mid-playback is
holding offsets that no longer describe the bytes: their next range request
returns the right number of wrong bytes, and the video garbles or stalls until
they reload. Media is also served `Cache-Control: immutable` with no validator,
so a browser that has already cached a video keeps the old copy — meaning the
videos you personally watch most are the ones least likely to improve until the
cache expires or you hard-reload.

Budget some time for it, too. `+faststart` writes the file and then shifts the
samples in a second in-place pass, so each video costs roughly four times its
size in reads and writes. That is nothing on a local disk — a thousand clips in
about a minute — but with `MEDIA_DIR` on a NAS it is bounded by the link: a
2,000-video library averaging 20 MB is roughly half an hour on gigabit and a
couple of hours on a contended share, saturating the volume the whole time.
Videos too large to remux within the per-file budget are logged and skipped
rather than left half-done.

## Splitting storage across volumes

`data/` holds three things with three different needs, and `DB_PATH`,
`MEDIA_DIR` and `DERIVED_DIR` let you put each where it belongs. Set none of
them and everything lives together under `data/`, which is the right answer
until you run out of room.

**Under Docker, every path you split off needs its own bind mount.** The
shipped `docker-compose.yml` mounts `./data:/app/data` and nothing else, so a
`DERIVED_DIR` pointing outside that resolves inside the container's writable
layer: it works, and then disappears on the next `docker compose up --build`,
with no error and nothing to indicate anything was lost. Mount each one and
point the variable at the container-side path:

```yaml
volumes:
  - ./data:/app/data
  - /mnt/nas/glyphstream-media:/app/media # MEDIA_DIR=/app/media
  - /srv/fast/glyphstream-derived:/app/derived # DERIVED_DIR=/app/derived
```

|               | What it is                          | Wants                                                              |
| ------------- | ----------------------------------- | ------------------------------------------------------------------ |
| `DB_PATH`     | SQLite database + WAL               | Fast **local** disk. Never a network share.                        |
| `MEDIA_DIR`   | Original images, video, uploads     | Space. Grows without bound — generated media is kept indefinitely. |
| `DERIVED_DIR` | Gallery thumbnails, vision variants | Fast disk. Small, hot, and rebuildable.                            |

The case for splitting them is a generation-heavy install on a box whose fast
disk is the small one. Media is the part that grows: the purger only reaps
abandoned uploads, so everything you generate is kept.

**Media on a network share is fine; the database is not.** SQLite's problem
over NFS/SMB is byte-range locking and mmap. Media files are write-once opaque
blobs, created by writing a `.tmp` sibling and renaming it within the same
directory — no locking, no concurrent writers to one file, no mmap. So
`MEDIA_DIR` can point at a NAS mount while `DB_PATH` stays local. Two notes if
you do it:

- **Mount `soft`, not `hard`.** Node's filesystem calls run on the libuv
  thread pool (four threads by default). A hard mount that goes away blocks
  those threads indefinitely, and once they are all stuck every media read in
  the process stalls behind it. `soft` turns a NAS reboot into failed media
  requests instead of a wedged server.
- **Set `DERIVED_DIR` to local disk.** This is the one that decides whether
  the move is felt. Without it, the two hottest paths in the app end up on the
  slow volume: a cold gallery viewport asks for 30-60 thumbnails at once, and
  a vision variant is re-read on _every turn_ for the life of a conversation.
  Budget about a tenth of `MEDIA_DIR` and you will usually have room to
  spare. Measured over generated PNGs: a thumbnail is ~1/70th of its original
  (~33 KB against ~2.4 MB) and exists for every image you have looked at in
  the gallery, while a vision variant is ~1/13th and exists only for images
  actually sent to a model. A library where every image had both would come to
  roughly 1/11th of the originals; a generation-heavy one lands well below
  that, since most of what it stores is never inlined into a request.

Derived assets are regenerable: point `DERIVED_DIR` somewhere empty and they
are rebuilt lazily on first view, at the cost of one re-encode each. To keep
the ones you have instead, move them — the relative paths are identical under
either root:

```bash
# Absolute paths, set by hand. The values in .env are read by the app, not
# exported into your shell, and the shipped defaults are relative — a relative
# second path would land inside the first once you have cd'd into it.
MEDIA=/srv/glyphstream/data/media
DERIVED=/srv/glyphstream-fast/derived

mkdir -p "$DERIVED"
cd "$MEDIA"     # cpio copies the paths it is given, so run it from the root
find . \( -name '*.thumb.jpg' -o -name '*.vision.jpg' \) | cpio -pdm "$DERIVED"

# Only after DERIVED_DIR is set and the app restarted:
find "$MEDIA" \( -name '*.thumb.jpg' -o -name '*.vision.jpg' \) -delete
```

Do the second `find` only once you have set `DERIVED_DIR` and restarted.
Leftovers under `MEDIA_DIR` are inert but permanent: deleting an image reaps
its derivatives from `DERIVED_DIR` only, so anything left on the old root is
never swept.

## Public exposure (TLS + HTTP/2)

adapter-node speaks HTTP/1.1 only. Put a reverse proxy in front for TLS +
HTTP/2 (and HTTP/3 if you want it). Set `EXTERNAL_BASE_URL` in `.env` to the
public origin so the OAuth redirect URI matches (see the
[authentication guide](authentication.md)).

Any pass-through reverse proxy works — pre-compression of static assets is
handled inside Node, so as long as the proxy forwards `Accept-Encoding`
(which all do by default) the brotli/gzip variants reach the client
unchanged. Tested with:

- **Synology DSM Reverse Proxy** (Login Portal → Advanced → Reverse Proxy).
  Source: `https://glyphstream.{your}.synology.me:443` → Destination:
  `localhost:3000`. Tick "Enable HTTP/2". Synology manages the cert via
  Let's Encrypt for `*.synology.me`. Synology does NOT expose a
  dynamic-compression option — set `COMPRESS_DYNAMIC=1` in `.env` (see
  below) to compress SSR HTML + API JSON inside GlyphStream instead.
- **Caddy** — `glyphstream.example.com { reverse_proxy 127.0.0.1:3000 }`.
  Auto-TLS, HTTP/2 + HTTP/3 on by default. Caddy compresses dynamic
  responses automatically and skips already-encoded static ones — no need to
  set `COMPRESS_DYNAMIC`.
- **Nginx** — `proxy_pass http://127.0.0.1:3000;` + `listen 443 ssl http2;`.
  Don't enable `gzip on` for the static `/_app/immutable/*` location or
  you'll double-compress; do enable it for the dynamic paths (or set
  `COMPRESS_DYNAMIC=1` and skip nginx-side gzip entirely). Either way,
  exclude `text/event-stream` so chat streaming isn't buffered.
- **Cloudflare Tunnel** — works as a transparent passthrough. Cloudflare
  compresses dynamic responses at the edge automatically.

> **Don't compress at the proxy for static assets.** adapter-node builds
> with `precompress: true`, so static assets ship as `.br` + `.gz` on disk
> and sirv negotiates via `Accept-Encoding`. Re-compressing at the proxy
> double-compresses.

## Client IP + auth rate limiting (`ADDRESS_HEADER`)

Requests to `/api/auth/*` that **aren't already signed in** are rate limited
per client address — 60 per minute by default (`AUTH_RATE_LIMIT_MAX`,
`AUTH_RATE_LIMIT_WINDOW_SECONDS`; `0` disables). The point isn't credential
guessing — session and invite tokens are far too large to guess — it's CPU.
Passkey login verification runs a full WebAuthn signature check on the same
single Node event loop that serves chat streaming, so unbounded volume there
degrades live conversations.

Signed-in requests are exempt deliberately: sharing one bucket (see below)
would otherwise let an unauthenticated flood lock real users out of logout and
the session-revocation endpoints — the controls you'd reach for during exactly
that incident. Sizing the limit against your users' normal traffic will
overshoot; size it against signed-out traffic only.

**Set `ADDRESS_HEADER=X-Forwarded-For` whenever a proxy is in front.** Without
it adapter-node reads the socket peer, which behind a proxy is the proxy on
every request — so the limiter collapses to one shared bucket for the entire
instance rather than isolating clients. The default limit is set high enough
that this degraded mode still won't touch a real household, but it's much
weaker than per-client limiting, and it does leave sign-in itself deniable by
a determined flood.

Make sure the proxy **sets** `X-Forwarded-For` itself rather than passing the
client's copy through untouched. adapter-node reads the **rightmost** entry at
the default `XFF_DEPTH=1`, so a proxy that appends its own view of the peer is
safe — any client-supplied prefix is ignored. For nginx that's
`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;`. What's unsafe
is forwarding the header unmodified, which is what nginx does if you set no
`proxy_set_header` for it at all: the whole value is then attacker-controlled.

With **more than one hop in front** (Cloudflare Tunnel or a CDN ahead of
nginx), keep appending and set `XFF_DEPTH` to the number of proxies between
the client and the app — `XFF_DEPTH=2` for that example. Do **not** use
`proxy_set_header X-Forwarded-For $remote_addr;` there: `$remote_addr` is the
CDN edge, so every client would collapse into one bucket, silently. If a
request ever arrives with fewer entries than `XFF_DEPTH` (a health check
hitting the origin directly, say), the address lookup fails and that request
falls back to the shared bucket rather than erroring.

## Dynamic-response compression (`COMPRESS_DYNAMIC`)

Off by default — most reverse proxies (Caddy, nginx with proper config,
Cloudflare) compress dynamic responses themselves, and doing it in both
places is wasted CPU. Turn it on when the proxy in front _can't_ compress
(Synology's built-in proxy is the canonical case):

```
COMPRESS_DYNAMIC=1
```

When enabled, GlyphStream picks the best codec the client advertises:
**zstd > brotli > gzip**. zstd at default level is the fastest of the three
on modern CPUs; the fallbacks cover older browsers. SSE
(`text/event-stream`) is always skipped so the chat-stream UI keeps flushing
events as they arrive. Static `/_app/immutable/*` assets are already
precompressed at build time and aren't affected by this flag.

The iOS launch-image block in `app.html` raises the stakes here. It adds ~21 KB
of `<link>` markup to **every** HTML document — that's most of a short page, and
it can push the response from two slow-start flights to four on a cold mobile
connection. Compressed it collapses to ~750 bytes brotli / ~1.3 KB gzip, so it's
effectively free the moment either the proxy or `COMPRESS_DYNAMIC=1` is
compressing. Uncompressed, it's a per-document floor you pay forever.

**Checking whether anything is compressing at all.** Open a long conversation,
then DevTools → Network → click the `/chat/<id>` _document_ request → Response
Headers. No `content-encoding` (or a "Transferred" size equal to "Size") means
nothing in the chain is compressing it — worth fixing, since SSR HTML is highly
repetitive markup and typically compresses ~8-15x.

**Cost note.** Compression runs on libuv's thread pool, not the event loop, so a
large payload no longer stalls every other request while it compresses. The work
itself still scales with payload, and a very long conversation's SSR HTML gets
large (a seeded 400-turn thread with a code block in every reply produced
~15 MB). Measured at that size: ~2-36 ms for zstd, ~9-71 ms for brotli,
~33-174 ms for gzip (range spans highly-repetitive to high-entropy content).
Modern browsers all negotiate zstd, so the common path stays cheap; the worst
case is an older client falling back to gzip on a huge thread, which now costs
that client latency rather than blocking in-flight SSE streams for everyone.
(The pool is shared with file I/O and defaults to 4 threads, so enough
concurrent huge responses can still queue behind each other.) If you have
threads that big, the durable fix is not serving a payload that size — see the
`ROADMAP.md` "Virtualized message list" entry, which measures where this
actually starts to matter.

## Diagnosing a slow load (the debug panel)

**Double-click (or double-tap) the version number** next to "GlyphStream" in
the sidebar header. Nothing points at it and it never appears on its own — it's
a "stats for nerds" readout, not a feature.

It reports the load that started the current session: how much of the wait was
the server (`Server (SSR)`, from a `Server-Timing` header) versus the network,
how long the service worker took to boot, when the page first painted, and how
many hashed app chunks came off the network rather than out of cache. **Copy**
puts the whole thing on the clipboard as text.

When `Server (SSR)` is the large number, several readings narrow it down:

- The breakdown under it splits that total into `auth` (the session lookup,
  which on a process's first request also carries the lazy SQLite open and
  migration), `render` (load functions plus the SSR render), and `zip`
  (`COMPRESS_DYNAMIC`, omitted when it isn't on).
- **Server uptime**, in the Environment section, is how long the Node process
  had been running when it served that page. A slow render on a process that is
  seconds old is a cold start — the first request after a restart pays for the
  database open and the upstream model-list fetch that every later one gets
  free. The same number on a process that has been up for hours is not, and
  points at the `render` phase instead.
- **Server CPU** is how much processor time the request actually burned as a
  share of that wall clock, followed in the same row by a count of major page
  faults. The share settles the question the total can't: near (or above) 100%
  means the server was genuinely working, and the answer is to make it do less;
  well under means it spent the difference _waiting_, which no amount of
  application tuning will fix. Over 100% is normal — the garbage collector and
  the I/O threadpool burn CPU on other threads alongside the request.

  The fault count then narrows down what it was waiting on: memory the host had
  evicted while the container sat idle, which the process then had to fetch
  back. The database is very much included — GlyphStream memory-maps it
  (`PRAGMA mmap_size`, see `src/lib/server/db/client.ts`), and clean file-backed
  pages need no swap to be reclaimed, so an idle container loses them first.
  **Server swap** and **Database file**, both below, say which memory was taken
  and whether the whole database was mapped in the first place. Check **Server uptime** before reading it, though: a process that
  is seconds old faults in its own binary, its libraries and the first touch of
  that mapping no matter how healthy the host is, and no memory reservation
  changes that. The signal is a nonzero count on a process that has been _up_ for
  hours — that one means the host is taking this container's memory back, and the
  levers are a memory reservation for it or a volume that isn't spinning down.
  Read it in one direction only: **zero does not clear it**, because writes, WAL
  reads and any part of the database past the 30 MB cap use ordinary file reads,
  which bill to wall time and never appear in this counter.

- **Event loop** is the longest stretch the server was unable to run anything
  while this request was open, and it is what makes the CPU share readable.
  Stalled with CPU to match means synchronous JavaScript held the process —
  either this request's own render or a background sweep it was queued behind.
  Stalled with almost no CPU means a blocking system call: `node:sqlite` reads
  synchronously, so a query that misses the page cache freezes the whole process
  for the length of the physical read while burning nothing, which the CPU share
  alone reports as an idle server. Not stalled and low CPU means the request
  waited on something that left the loop free, such as an awaited network call.
  (Host descheduling shows up as a stall, not here — the clock keeps running
  while the container is denied CPU.)
- **Database** is how much of that server time was spent inside synchronous
  SQLite. It is a slice of the render, not another part of the total, and it is
  what makes a large `render` answerable: a big number here against a small
  **Server CPU** is the database blocking the event loop on reads that missed the
  page cache. Read it as a floor rather than a total: only instrumented queries
  are counted, and that covers the launch path and the conversation page, so a
  small number on some other route may just mean nobody wrapped its queries. It
  matters less than it sounds for ordinary use — the panel reports the document
  that started the session, so navigating around in-app keeps showing the launch
  document's numbers regardless. A hard reload of another route is the case where
  a low number could mislead.
  Worth knowing that only part of such a wait shows up as major faults. Reads
  served from the memory-mapped region register a fault when they miss; anything
  past the mapping goes through ordinary file reads, which cost wall time and
  register no fault at all. A `Database` number with no faults behind it is that
  case — and **Database file** below tells you whether it applies.
- **Server memory**, in the Environment section beneath **Server uptime**, is the
  process's resident set. Read it against the major-fault count, across readings
  taken days apart: a footprint that climbs is a leak in GlyphStream, while one
  that holds steady while the fault count climbs is a healthy process being
  squeezed by a host short on memory. The fault count proves memory was
  reclaimed but says nothing about whose fault that is.
- **Server swap**, in the Environment section, is how much of the process is
  currently swapped out. It exists to finish the sentence the fault counter
  starts: major faults prove memory had to be fetched back, but count evicted
  file pages and swapped-out memory alike, and those have opposite fixes. A `0 MB`
  reading says the host reclaimed clean file-backed pages, which is cheap and
  largely a fact of life on a shared box. A nonzero one says the process itself
  was written out to disk and read back — worth acting on, by giving the
  container a memory reservation so the host stops choosing it, or by reducing
  what GlyphStream keeps in anonymous memory. The row is absent on non-Linux
  hosts, where there is nothing to read it from; it is never shown as a
  misleading zero.
- **Database file**, in the Environment section, is the database's size on disk
  against the memory mapping actually in force, plus the write-ahead log when one
  has built up. This is what decides how to read `Database` and the fault count
  above it. While the file fits its mapping the row says so, and a slow read
  shows up as a major fault. Once the file outgrows the mapping the row names the
  part that doesn't fit, and reads to that part go through `read(2)` — billed to
  wall time, invisible to the fault counter. The WAL is never mapped at all, so a
  log that has grown large is more of the same invisible I/O. The mapping figure
  is what SQLite reported back rather than what GlyphStream asked for: it clamps
  silently at a compile-time ceiling, and a build with mmap compiled out accepts
  the setting and stays at zero, which the row reports as `not mapped`.
- **Idle before this load**, in the Environment section, is how long the server
  had gone without serving anything before this request. Read it with **Server
  uptime**: a process up for a day that was busy throughout is a different
  machine from one up for a day that sat still for eight hours, because a host
  reclaims an idle container's memory. Read it as a floor on _client_ traffic and
  nothing more: any client resets it, including a background tab, while the
  container's own health probe deliberately does not — and the background
  sweepers wake on 5- and 15-minute cadences and touch the database without
  resetting it, so a large reading here does not mean the process was quiet or
  that a disk was ever allowed to spin down.
- **Service worker** carries the build of the worker actually in charge, which
  is not always the build the page came from. A new worker waits for you to
  accept the update prompt, while the page itself arrives fresh from the server
  on every launch — so the panel can read `0.36.0` while an older worker still
  handles the app's fetches, and anything that worker introduced (caching,
  offline behaviour) is simply not in effect yet. The row says so explicitly
  when they differ.
- **Launch image** answers whether iOS had a splash image matching this exact
  device, by running each declared `apple-touch-startup-image` media query
  through `matchMedia` on the hardware itself. `no match` means the geometry list
  is missing this device — add a row and re-run `pnpm gen:splash`, using the CSS
  geometry printed beside it. `matched` means the image exists and iOS chose not
  to use it, which no amount of adding images will fix; the usual cause is iOS
  restoring a saved snapshot instead of performing a true cold launch. Shown only
  for an iOS home-screen launch: a browser tab has no launch image, and an
  installed Android or desktop PWA has no use for the iOS-only list.

The reason it exists is the one load you can't attach a debugger to: an **iOS
home-screen app's cold launch**. Safari Web Inspector needs a Mac and a cable,
and by the time you're attached the launch is already over. The panel works
after the fact because the timings describe the _document_, and client-side
navigation never replaces it — so a cold launch, then a few taps to open the
panel, still shows the cold launch.

Two things it can't tell you:

- **Everything before the first byte of the page is invisible to it** — the icon
  tap, the WebKit process starting, the app's own launch image. If the numbers
  add up to far less than the delay you felt, that gap _is_ iOS process startup,
  and no amount of app-side tuning moves it.
- A reverse proxy that strips `Server-Timing` will blank the `Server (SSR)` and
  `Network` rows. The combined `TTFB` is still shown next to `Network`.
