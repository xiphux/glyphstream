# GlyphStream

Lightweight chat frontend for any OpenAI-compatible backend.

GlyphStream sits in front of N OpenAI-compatible upstream endpoints
(llama-server, vLLM, Groq, OpenAI, [openai-api-bridge][bridge] for
ComfyUI/Venice, anything that speaks `/v1/chat/completions`) and aggregates
them into a single chat UI with one model picker.

Designed to replace Open WebUI for users who want:

- **Lightweight and fast.** Virtualized message lists, server-rendered+cached
  markdown, fine-grained reactivity, lean dependency tree, single-process
  deployment.
- **Multi-backend without per-frontend coupling.** Develops against the
  OpenAI spec, not against any specific upstream.
- **Image and video** rendering inline (when an upstream supports them via
  `/v1/images` or `/v1/videos`).
- **Permanent media storage.** Generated assets are pulled from upstream and
  stored locally on first generation; ref-counted; auto-purged after a grace
  period when no conversation references them.
- **Custom models** = preset of (base model + system prompt + params), like
  custom GPTs.
- **OAuth login with closed allowlist** for safe self-hosting on the public
  internet.
- **PWA** — installable to iPhone homescreen.

[bridge]: https://github.com/xiphux/openai-api-bridge

## Status

v0.0.1 — scaffold ready. See `ROADMAP.md` for what's coming.

## Stack

SvelteKit (adapter-node) · TypeScript · Tailwind v4 · Drizzle ORM (SQLite, dialect-portable) · Lucia v3 + arctic for OAuth · bits-ui for headless primitives · pnpm.

## Running locally

```bash
pnpm install
cp .env.example .env       # fill in AUTH_SECRET, GitHub OAuth, allowlist
cp config.toml.example config.toml   # define at least one upstream
pnpm db:generate           # generate the initial migration
pnpm dev                   # http://localhost:5173
```

## Configuration

Two files, by concern:

- **`config.toml`** — endpoint definitions (one block per upstream). Safe to
  commit to a private repo because secrets live in env vars referenced by
  `*_env` field names.
- **`.env`** — auth secrets, GitHub OAuth credentials, the allowlist, file
  paths. Never committed.

See `config.toml.example` and `.env.example` for the full surface.

## Architecture

See the design plan referenced during development. In brief:

```
GitHub OAuth → SvelteKit /api/auth/github → session cookie
                          │
                          ▼
              SvelteKit (Node, single process)
                          │
   ┌──────────────────────┼──────────────────────┐
   │                      │                      │
   ▼                      ▼                      ▼
SQLite (chats,       MediaStore (disk)    Endpoint registry
 messages,                                       │
 media refs,                       ┌─────────────┼─────────────┐
 custom models)                    ▼             ▼             ▼
                            openai-api-bridge  llama-server   Groq
```

## Deployment (Docker)

Multi-stage Alpine build. Final image is ~140 MB; everything's
self-contained except the SQLite DB and generated media (kept on a
bind-mount so they survive `up/down`) and `config.toml` (mounted
read-only so the container can't modify it).

```bash
# 1. Set up the host directory
mkdir -p /srv/glyphstream/data
cd /srv/glyphstream
cp /path/to/repo/.env.example .env       # then edit
cp /path/to/repo/config.toml.example config.toml  # then edit
cp /path/to/repo/docker-compose.yml .

# 2. Bring up
docker compose up -d --build

# 3. Verify
curl http://localhost:3000/api/health
docker compose logs -f glyphstream
```

`docker compose up` runs `pnpm build` inside the builder stage and
applies any pending Drizzle migrations on first DB open. Subsequent
restarts are zero-downtime as long as you only changed env vars or
`config.toml` (no rebuild needed for those — just `docker compose
restart`).

### Public exposure (TLS + HTTP/2)

adapter-node speaks HTTP/1.1 only — Node's built-in `http` module
doesn't do HTTP/2. Put a reverse proxy in front for TLS termination
+ HTTP/2 (and HTTP/3 if you want it). Set `PUBLIC_BASE_URL` in
`.env` to the public origin so OAuth redirect URIs match.

Pretty much any pass-through reverse proxy works — pre-compression
(see below) is handled inside Node, so the proxy just forwards the
`Accept-Encoding` header and the compressed response unchanged.
Tested with:

- **Synology DSM Reverse Proxy** (Login Portal → Advanced → Reverse
  Proxy). Source: `https://glyphstream.{your}.synology.me:443` →
  Destination: `localhost:3000` (or the container's IP). Tick
  "Enable HTTP/2" on the rule. Synology handles the cert via
  built-in Let's Encrypt for `*.synology.me`.
- **Caddy** — 4-line config: `glyphstream.example.com { encode br
  gzip; reverse_proxy 127.0.0.1:3000 }`. Auto-TLS, HTTP/2 + HTTP/3
  on by default.
- **Nginx** — `proxy_pass http://127.0.0.1:3000;` plus `listen 443
  ssl http2;` on the server block. Don't enable `gzip on` for
  proxied responses or you'll double-compress.
- **Cloudflare Tunnel** — works as a transparent passthrough.

### Pre-compression

`svelte.config.js` enables `precompress: true` on adapter-node, so
every static asset gets a `.br` + `.gz` variant generated at build
time. adapter-node's static server (sirv) serves the right one
based on `Accept-Encoding`. Brotli typically gets us 65-75% off
text assets — the largest JS chunk drops from 95 KB → 26 KB. No
per-request CPU spent compressing.

### Bundle analysis

```bash
pnpm analyze    # builds with rollup-plugin-visualizer enabled
open bundle-stats.html
```

Generates a treemap of the client bundle with gzip + brotli sizes.
Useful for spotting regressions when adding deps; current baseline
is ~250 KB gzip total (without shiki, which stays server-side).

## License

MIT
