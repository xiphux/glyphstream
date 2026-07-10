---
name: verify
description: Launch and drive GlyphStream to observe a change working end-to-end.
---

# Verifying GlyphStream changes

Two ways to get a running app. Prefer the first — it's faster and has the
operator's real models, presets, and conversations.

## 1. Attach to the user's dev server (preferred)

`pnpm dev` on http://localhost:5173. Every page under `(app)` requires auth, so
inject a session cookie:

```bash
playwright-cli open http://localhost:5173
playwright-cli cookie-set glyphstream_session <token> --domain=localhost --httpOnly
playwright-cli goto http://localhost:5173
```

Ask the user for a session token (they can read one out of their browser). The
dev DB is `./data/glyphstream.db` — query it directly with `sqlite3` to confirm
what the server actually persisted, which is usually stronger evidence than the
UI alone.

**Migrations run at server startup.** After adding one, the dev server must be
restarted before the new column exists. Check first:

```bash
sqlite3 ./data/glyphstream.db "PRAGMA table_info(messages);"
```

**This is real user data.** Never delete conversations or media. Sending a
prompt hits their real backend (llama.cpp on `dirac`) and creates a real
conversation — keep it to one short prompt and tell them what you created.

## 2. Cold boot with a seeded DB and mock upstream

No auth token needed; you mint your own session. Reuses the e2e fixtures.

```bash
# 1. mock OpenAI-compatible upstream (advertises a chat + an image model)
MOCK_UPSTREAM_PORT=3001 node tests/e2e/fixtures/mock-upstream.mjs &

# 2. seed a DB: run drizzle's migrator, then raw-SQL INSERT a user + session.
#    Mirror tests/e2e/global-setup.ts: cookie value is a random token, the
#    sessions.id column stores its sha256. Import schema.ts from a *.ts* file
#    or use raw SQL — plain node can't load the TS module.
#    The script must live in the repo root so drizzle-orm resolves.

# 3. build + boot
pnpm build
HOST=127.0.0.1 PORT=3210 DB_PATH=/tmp/gs/test.db MEDIA_DIR=/tmp/gs/media \
  AUTH_SECRET='verify-secret-not-used-in-prod-32chars' \
  GITHUB_OAUTH_CLIENT_ID=stub GITHUB_OAUTH_CLIENT_SECRET=stub \
  EXTERNAL_BASE_URL=http://localhost:3210 \
  CONFIG_PATH=tests/e2e/fixtures/config.toml LOG_LEVEL=warn \
  node build/index.js &
```

Readiness probes: `GET /api/health` (app), `GET /v1/models` (mock).

## Driving the chat UI

Stable handles, all ARIA:

- model picker — `button[aria-label="Select model"]`; its `innerText` is the
  current model's display name (or `N models` in compare mode)
- picking a model — click the picker, then `getByRole('option', {name: …})`
- compare mode — the `Multiple` button inside the open picker; send button
  becomes `Send to N models`
- feature toggles — `button[aria-label="Feature toggles"]`, then
  `[role=switch][aria-label="Web access"]` etc. Read `aria-checked`.
  `Escape` closes the menu.
- per-message actions — `Copy message`, `Edit message`, `Retry`,
  `New chat from this prompt`, `Delete this branch`. They're `opacity-0` until
  hover but Playwright still sees them.
- confirm dialogs are in-app (`$lib/confirm.svelte`), NOT `window.confirm` —
  `page.on('dialog')` will never fire. Click the `Delete` button.

### Gotchas

- **Feature toggles are kind-scoped.** `image_prompt_enhancement` /
  `video_prompt_enhancement` don't render for a chat model, so they're
  unobservable there — pick `personalization` or `web` when you need a toggle
  you can see on a chat conversation.
- **A parked fan-out sets `generating`**, which disables Edit _and_ New-chat-
  from-prompt on the whole page, even after every column has settled. A
  conversation whose compare grid was never resolved is a bad subject.
- **During a parked fan-out the sibling assistants aren't on the active
  branch** — `walkActiveBranch` returns only the pinned user message. Read them
  with `getSiblingAssistants`.
- Composer text autosaves to `localStorage['glyphstream:composerDraft:new']`
  (debounced ~500ms), so a prompt you put in the box survives navigation.
