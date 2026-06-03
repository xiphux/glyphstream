# CLAUDE.md

Project-specific guide. Kept terse — every line lives in every conversation's
context, so include something only if forgetting it would cause a real
mistake.

## What this is

Lightweight chat frontend for OpenAI-compatible backends. Self-hosted,
single-Node-process, SQLite. Solo-user UX with a multi-user-shaped data
model.

## Stack

SvelteKit (adapter-node) · TypeScript · Tailwind v4 · Drizzle ORM (SQLite,
dialect-portable) · arctic (GitHub OAuth) + @simplewebauthn (passkeys),
custom Lucia-style session module · bits-ui (headless) · markdown-it +
shiki · Vitest + Playwright · pnpm.

## Layout

```
src/lib/server/       # server-only code (DB queries, auth, endpoints, media, streaming)
src/lib/              # client-safe code (greeting, markdown-live, types)
src/lib/components/   # Svelte components
src/routes/           # SvelteKit routes (pages + API)
drizzle/              # generated migration SQL
tests/unit/           # vitest (pure-logic + DB-backed via in-memory SQLite)
tests/component/      # vitest + @testing-library/svelte + happy-dom — see its README
tests/e2e/            # playwright (production-build webServer)
```

## Core directions (constraints, not preferences)

- **Lightweight and fast** is a hard constraint, not a "nice to have". Every
  architectural choice should pass "is this faster/leaner than the
  alternative?". No heavy component libraries. Markdown renders server-side
  with shiki and is cached on the message row (`content_html`). Client
  bundle target ceiling is ~250 KB gzip.
- **Develop against the OpenAI spec, not a specific upstream.** The bridge
  (`openai-api-bridge`) is one possible endpoint, not a hard dep. Per-vendor
  quirks live in `src/lib/server/streaming/normalizers.ts`, opted into via
  `provider_quirk` in `config.toml`.
- **Architecture-now-for-v2-later.** Schema is tree-shaped
  (`parent_message_id` + `active_leaf_message_id`) so branching UI lands in
  v2 with no migration. Every row has `user_id` so multi-user adds an admin
  UI in v2 without schema work. `MediaStore` interface so S3 swap is a
  single new file.
- **Self-hosted on the public internet is the deployment target.** GitHub
  OAuth + numeric-ID allowlist (NOT username — usernames can be reassigned).
  Reverse proxy in front for TLS + HTTP/2.

## Conventions

- Custom models are saved presets of (base model + system prompt + params).
  Materialized onto the conversation at create time — editing the preset
  doesn't retroactively change existing chats.
- Media is ref-counted via the `message_media` join table. The background
  purger sweeps zero-ref rows past `MEDIA_GRACE_PERIOD_DAYS`.
- Per-endpoint secrets use the `*_env` field convention in `config.toml`:
  the field stores the _name_ of an env var, never the secret itself.
- `await parent()` at the start of every `(app)` page server load. Without
  it the page's `locals.user!.id` deref races with the layout's
  redirect-on-no-auth and surfaces a 500 instead of a 302.
- `bits-ui` and `lucide-svelte` belong in `devDependencies` — Vite bundles
  them into the SSR build at compile time. Only packages that run
  server-side at request time (`drizzle-orm`, `shiki`, `markdown-it`,
  `arctic`, `better-sqlite3`, `smol-toml`) belong in `dependencies`.
- Component tests live under `tests/component/` and require a per-file
  `/* @vitest-environment happy-dom */` header — pure-logic unit tests
  default to `node`. See `tests/component/README.md` for the bits-ui
  Portal + `data-state` gotchas; forgetting them surfaces as DOM queries
  silently missing portaled content.

## Common commands

```
pnpm dev          # http://localhost:5173
pnpm check        # svelte-check (type + a11y)
pnpm test         # vitest unit tests
pnpm test:e2e     # playwright (auto-builds + boots production server)
pnpm db:generate  # generate a drizzle migration after schema edits
pnpm analyze      # production build with rollup-plugin-visualizer
```

## Sharp edges

- **pnpm 10 + native modules**: `pnpm install` blocks better-sqlite3's build
  script in CI even with `pnpm.onlyBuiltDependencies` set. The dance is
  `pnpm install --frozen-lockfile --ignore-scripts` then `pnpm rebuild
better-sqlite3 esbuild`. Same in Docker; same in CI.
- **Shiki on the client is route-lazy + grammar-subsetted only.** The
  full shiki bundle is ~500 KB and must stay server-side — that's where
  the persisted post-stream HTML gets its full-coverage highlighting.
  For the live in-flight render, the chat route lazy-loads a tiny
  subset (`shiki/core` + JS regex engine + the `python` and `markdown`
  grammars + the two github themes, ~72 KB gzip) via
  `src/lib/markdown-live-shiki.svelte.ts`. Languages outside those two
  still render as plain `<pre><code>` during streaming and pick up the
  server's full highlight when persistence swaps in. Do NOT pull the
  oniguruma WASM engine or any additional grammars into this client
  path — it costs 50–200 KB raw per grammar and the marginal value
  past Python tails off fast.
- **Don't compress at the reverse proxy.** adapter-node has `precompress:
true`, so static assets ship as `.br` + `.gz` on disk and sirv negotiates
  via `Accept-Encoding`. Re-compressing at the proxy double-compresses.
- **Allowlist by numeric GitHub user ID, not username.** Usernames can be
  deleted and re-registered by someone else.
- **`schema.ts` must stay `$lib`-free.** It's loaded outside the Vite
  build — by drizzle-kit, the `import-owui` esbuild bundle, and
  Playwright's e2e `global-setup.ts` — none of which resolve the `$lib`
  alias. Import shared code into it with a relative path.
- **Tailwind v4, not v3.** Two of v4's syntax changes silently produce
  no CSS instead of erroring, and we've stepped on both:
  - Important modifier moved from prefix to **suffix**: `mt-0!` is
    correct, `!mt-0` (v3) silently emits nothing.
  - `space-y-*` now sets `margin-block-end` on _every_ child (v3 set
    `margin-top` on subsequent siblings via `* + *`). Closing a gap
    between two specific siblings means overriding `mb-0!` on the
    upper child, not `mt-0!` on the lower one.
    When something visual doesn't apply, check the generated CSS in
    the inline `<style data-sveltekit>` to confirm Tailwind picked the
    class up — silent no-op is the failure mode here.

## Roadmap

`ROADMAP.md` lists v1.x + v2 items deliberately deferred, each with the
why. Check before starting a "wouldn't it be nice if…" — it's probably
already there with the rationale already worked out.
