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

> **Need image / video generation?** [openai-api-bridge][bridge] is a
> companion project that fronts ComfyUI workflows and Venice image
> generation behind an OpenAI-compatible HTTP API — point GlyphStream
> at it and the models show up in the picker alongside your chat
> backends.

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

See `config.toml.example` and `.env.example` for the full surface. The
[GitHub authentication](#github-authentication) section below walks
through the three OAuth-related env vars in detail.

## GitHub authentication

GlyphStream signs users in via GitHub OAuth with a **numeric-user-id
allowlist** — no public registration, no password store, only specific
accounts can log in. Three pieces to set up:

### 1. Create a GitHub OAuth App

Go to [github.com/settings/developers](https://github.com/settings/developers)
→ **New OAuth App**. Fill in:

| Field | Value |
|---|---|
| **Application name** | Anything you like (e.g. `GlyphStream`) |
| **Homepage URL** | Your public origin — same value you'll set for `EXTERNAL_BASE_URL`. Examples: `http://localhost:5173` for local dev, `https://glyphstream.example.com` for prod |
| **Authorization callback URL** | The homepage URL + `/api/auth/github/callback`. E.g. `http://localhost:5173/api/auth/github/callback` or `https://glyphstream.example.com/api/auth/github/callback` |

After creation, click **Generate a new client secret** and capture both:

- **Client ID** → `GITHUB_OAUTH_CLIENT_ID` in `.env`
- **Client secret** → `GITHUB_OAUTH_CLIENT_SECRET` in `.env`

### 2. Find your numeric GitHub user ID

The allowlist matches on **numeric ID, not username**. Usernames can be
deleted and re-registered by someone else; numeric IDs are immutable
and tied to the original account. Fetch yours from GitHub's public API:

```bash
curl -s https://api.github.com/users/<your-login> | grep '"id":'
#   "id": 1234567,
```

(Or open `https://api.github.com/users/<your-login>` in a browser if you
don't have curl/grep handy.)

Add it to `.env` as a comma-separated list (one or more allowed users):

```
ALLOWED_GITHUB_USER_IDS=1234567
```

### 3. Wire EXTERNAL_BASE_URL to the same origin

GlyphStream constructs the OAuth callback URL it sends to GitHub as
`${EXTERNAL_BASE_URL}/api/auth/github/callback`. This has to match the
**Authorization callback URL** registered in the GitHub app exactly —
scheme (`http` vs `https`), host, port (when non-default), no trailing
slash. A mismatch surfaces as GitHub's `"redirect_uri is not associated
with this application"` error after the user clicks Sign In.

```
# Local dev
EXTERNAL_BASE_URL=http://localhost:5173

# Production behind a reverse proxy
EXTERNAL_BASE_URL=https://glyphstream.example.com
```

> **Why `EXTERNAL_` instead of `PUBLIC_`?** SvelteKit reserves the
> `PUBLIC_` prefix for env vars exposed to browser code. A
> `PUBLIC_BASE_URL` would silently fail to read server-side and
> default to `localhost`, which then mismatches the OAuth callback in
> production. The `EXTERNAL_` prefix dodges that footgun.

## Push notifications (optional)

GlyphStream can fire OS-level push notifications when an assistant
message finishes — useful for multi-minute video generations, or just
walking away from a long answer. The feature is **off by default**;
without VAPID keys configured, the master switch in **Settings →
Preferences → Notifications** stays inert and the rest of the app is
unaffected. To enable:

### 1. Generate a VAPID keypair

```bash
npx web-push generate-vapid-keys
```

The public key is fine to commit; the private key is a secret.

### 2. Add a `[notifications]` block to `config.toml`

```toml
[notifications]
vapid_public = "BPI...your-public-key..."
vapid_private_env = "VAPID_PRIVATE_KEY"
vapid_subject = "mailto:admin@example.com"
```

The `vapid_private_env` field is the **name** of the env var holding
the private key, following the same `*_env` convention as endpoint API
keys — the secret never lives in `config.toml`.

### 3. Set the private key in `.env`

```
VAPID_PRIVATE_KEY=your-private-key-here
```

Restart the server. Users can now opt in via **Settings → Preferences
→ Notifications**.

> **iPhone / iPad users:** iOS Safari only delivers push to PWAs
> installed to the Home Screen. Open GlyphStream in Safari → share
> sheet → **Add to Home Screen**, then launch the app from the icon
> (not the Safari tab) before enabling notifications. The settings UI
> detects this and shows a hint when the install step is missing.

See `docs/notifications.md` for the full feature: privacy model,
multi-device behavior, troubleshooting, and developer reference.

## Deployment

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

Drizzle migrations apply automatically on first DB open. Subsequent
config or env changes only need `docker compose restart` — no rebuild.

## Importing from Open WebUI

GlyphStream ships a one-shot script for migrating chat history out of
Open WebUI. It walks OWUI's tree-shaped export into the matching
GlyphStream schema, splits reasoning blocks (`<details type="reasoning">`)
into structured parts, and renders assistant markdown to HTML so the UI
shows formatted output immediately.

```bash
# 1. In OWUI: Settings → "Export All Chats" → save the JSON file.

# 2. Drop the export onto the host alongside docker-compose.yml.
mkdir -p /srv/glyphstream/imports
cp ~/Downloads/owui-export.json /srv/glyphstream/imports/

# 3. Find your GlyphStream user id (you must have logged in via OAuth
#    at least once for the row to exist).
docker compose exec glyphstream sqlite3 /app/data/glyphstream.db \
  "SELECT id, github_username FROM users;"

# 4. Dry-run first to see counts without writing.
docker compose exec glyphstream node /app/build/scripts/import-owui.js \
  /app/imports/owui-export.json --user-id <your-uuid> --dry-run

# 5. Real run.
docker compose exec glyphstream node /app/build/scripts/import-owui.js \
  /app/imports/owui-export.json --user-id <your-uuid>
```

Caveats:

- Imported conversations get a synthetic `endpoint_id = 'imported-owui'` —
  full history is preserved and viewable, but sending a *new* message in
  an imported conversation will fail with "endpoint not configured" until
  a future "reassign endpoint" UI lands.
- OWUI's export references images by URL to its own file API; once OWUI
  is shut down those URLs 404. The script rewrites image references to
  an `_[image unavailable]_` placeholder so the surrounding text still
  reads coherently.
- Re-running the script will create duplicates (no idempotency check yet).
  To re-import cleanly, wipe previous imports first:
  `sqlite3 /app/data/glyphstream.db "DELETE FROM conversations WHERE endpoint_id = 'imported-owui';"`

For local dev (no Docker): `pnpm import:owui <export.json> --user-id <uuid>`.

## Public exposure (TLS + HTTP/2)

adapter-node speaks HTTP/1.1 only. Put a reverse proxy in front for
TLS + HTTP/2 (and HTTP/3 if you want it). Set `EXTERNAL_BASE_URL` in `.env`
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
