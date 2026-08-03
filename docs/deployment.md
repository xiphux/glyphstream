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
```

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

`/api/auth/*` is rate limited per client address — 60 requests per minute by
default (`AUTH_RATE_LIMIT_MAX`, `AUTH_RATE_LIMIT_WINDOW_SECONDS`; `0`
disables). The point isn't credential guessing — session and invite tokens are
far too large to guess — it's CPU. Passkey login verification runs a full
WebAuthn signature check on the same single Node event loop that serves chat
streaming, so unbounded volume there degrades live conversations.

**Set `ADDRESS_HEADER=X-Forwarded-For` whenever a proxy is in front.** Without
it adapter-node reads the socket peer, which behind a proxy is the proxy on
every request — so the limiter collapses to one shared bucket for the entire
instance rather than isolating clients. The default limit is set high enough
that this degraded mode still won't touch a real household, but it's much
weaker than per-client limiting.

Make sure the proxy **overwrites** `X-Forwarded-For` rather than appending to
it. If a client-supplied value survives, an attacker picks their own bucket
key and the limit means nothing. Caddy and Synology's reverse proxy do this by
default; for nginx use `proxy_set_header X-Forwarded-For $remote_addr;` (not
`$proxy_add_x_forwarded_for`, which appends).

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
