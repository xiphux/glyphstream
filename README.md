# GlyphStream

Lightweight chat frontend for any OpenAI-compatible backend.

GlyphStream sits in front of N OpenAI-compatible upstream endpoints
(llama-server, vLLM, Groq, OpenAI, [openai-api-bridge][bridge] for
ComfyUI/Venice, anything that speaks `/v1/chat/completions`) and aggregates
them into a single chat UI with one model picker.

- **Lightweight and fast.** Server-rendered + cached markdown,
  fine-grained reactivity (Svelte 5 runes), lean dependency tree, ~200 KB
  gzip client bundle, single-process deployment.
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

## Deployment

Multi-stage Alpine Docker image, ~200 MB final size. Bind-mount `data/` for
persistence and mount `config.toml` read-only:

```bash
mkdir -p /srv/glyphstream/data
cd /srv/glyphstream
cp /path/to/repo/.env.example .env       # then edit
cp /path/to/repo/config.toml.example config.toml  # then edit
cp /path/to/repo/docker-compose.yml .
docker compose up -d --build
curl http://localhost:3000/api/health
```

Drizzle migrations apply automatically on first DB open. Subsequent
config or env changes only need `docker compose restart` — no rebuild.

## Public exposure (TLS + HTTP/2)

adapter-node speaks HTTP/1.1 only. Put a reverse proxy in front for
TLS + HTTP/2 (and HTTP/3 if you want it). Set `PUBLIC_BASE_URL` in `.env`
to the public origin so the OAuth redirect URI matches.

Any pass-through reverse proxy works — pre-compression is handled inside
Node, so as long as the proxy forwards `Accept-Encoding` (which all do
by default) the brotli/gzip variants reach the client unchanged. Tested
with:

- **Synology DSM Reverse Proxy** (Login Portal → Advanced → Reverse
  Proxy). Source: `https://glyphstream.{your}.synology.me:443` →
  Destination: `localhost:3000`. Tick "Enable HTTP/2". Synology
  manages the cert via Let's Encrypt for `*.synology.me`.
- **Caddy** — `glyphstream.example.com { reverse_proxy 127.0.0.1:3000 }`.
  Auto-TLS, HTTP/2 + HTTP/3 on by default.
- **Nginx** — `proxy_pass http://127.0.0.1:3000;` + `listen 443 ssl http2;`.
  Don't enable `gzip on` for proxied responses or you'll double-compress.
- **Cloudflare Tunnel** — works as a transparent passthrough.

## License

MIT — see `LICENSE`.
