# Deployment

## Docker

Multi-stage Alpine Docker image, ~200 MB final size. Bind-mount `data/` for
persistence and mount `config.toml` read-only:

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
  back. The database is very much included — GlyphStream maps the first 30 MB of
  it (`PRAGMA mmap_size`, see `src/lib/server/db/client.ts`), and clean
  file-backed pages need no swap to be reclaimed, so an idle container loses
  them first. Check **Server uptime** before reading it, though: a process that
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
- **Server memory**, in the Environment section beneath **Server uptime**, is the
  process's resident set. Read it against the major-fault count, across readings
  taken days apart: a footprint that climbs is a leak in GlyphStream, while one
  that holds steady while the fault count climbs is a healthy process being
  squeezed by a host short on memory. The fault count proves memory was
  reclaimed but says nothing about whose fault that is.
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
