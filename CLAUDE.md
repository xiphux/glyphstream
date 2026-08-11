# CLAUDE.md

Project-specific guide. Kept terse — every line lives in every conversation's
context, so include something only if forgetting it would cause a real
mistake.

## What this is

Lightweight chat frontend for OpenAI-compatible backends. Self-hosted,
single-Node-process, SQLite. Officially multi-user: the setup-wizard user is
an `admin`; everyone else joins by an admin-issued invite (`/join/<token>`).
Still optimized for the small-team / household scale, not SaaS.

## Stack

SvelteKit (adapter-node) · TypeScript · Tailwind v4 · Drizzle ORM (SQLite,
dialect-portable) · in-tree OAuth2 client (`auth/oauth/oauth2.ts`) +
@simplewebauthn (passkeys), custom Lucia-style session module · bits-ui
(headless) · markdown-it + shiki · Vitest + Playwright · pnpm.

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
  with shiki and is cached on the message row (`content_html`). Initial
  chat-route load target ceiling is ~250 KB gzip (the _entry + initial
  chunks_, not the sum of all chunks — shiki/markdown-it/pyodide are
  route-lazy, so the all-chunks total runs higher and isn't the metric).
- **Develop against the OpenAI spec, not a specific upstream.** The bridge
  (`openai-api-bridge`) is one possible endpoint, not a hard dep. Per-vendor
  quirks live in `src/lib/server/streaming/normalizers.ts`, opted into via
  `provider_quirk` in `config.toml`.
- **Architecture-now-for-v2-later.** Schema is tree-shaped
  (`parent_message_id` + `active_leaf_message_id`) so branching UI lands in
  v2 with no migration. Every row carries `user_id` and queries scope by it
  (the multi-user isolation invariant — don't add an unscoped read of a
  user-owned table). `MediaStore` interface so S3 swap is a single new file.
- **Self-hosted on the public internet is the deployment target.** Auth is
  GitHub OAuth + passkeys; access is gated per-user by `users.disabled_at`
  (toggled from `/settings/admin`), NOT a config allowlist. Account creation
  is invite-only after the first (admin) user. Reverse proxy in front for
  TLS + HTTP/2.
- **The upstream payload is rent, and its prefix must be stable.** The system
  prompt and `tools[]` are re-sent on _every_ turn, so a sentence added to a
  tool description is charged per turn, forever (`tool-definition-budget.test.ts`
  holds the line — a failure there is a request to justify the growth, not a
  bug). Upstreams also reuse a KV cache for the longest common token _prefix_,
  so a payload that differs when nothing meaningful changed re-prefills the
  whole conversation — and when it's `tools[]`, the model's capabilities visibly
  blink in and out. What the **user** did may change the payload (saving a
  memory, enabling a skill, compacting); **timing** must not — a slow MCP
  handshake, a registration race, an `ORDER BY` with no tiebreak. Corollaries:
  send-time trims must be deterministic (same branch → same bytes; never
  age-based), and anything grown mid-conversation is _appended_ so it extends
  the suffix rather than reshuffling the prefix. `/api/conversations/:id/context`
  (the breakdown behind the context readout) prices what's actually being sent.

## Conventions

- Custom models are saved presets of (base model + system prompt + params).
  Materialized onto the conversation at create time — editing the preset
  doesn't retroactively change existing chats.
- Media is ref-counted via the `message_media` join table. Generated media
  is kept indefinitely; the background purger only reaps abandoned uploads,
  on a hardcoded cadence (see `src/lib/server/media/purger.ts`).
- Background sweepers (purger, embedding + topic backfill, dreaming,
  conversation summaries) mount through `createSweeper`
  (`server/util/sweeper.ts`) — don't hand-roll another recursive
  `setTimeout`. Five copies had drifted and two lacked the generation
  token, so a `stop()` landing during an in-flight sweep re-armed the
  worker (`clearTimeout` can't cancel a pending promise continuation) and
  a later `start()` left two live chains. Each `runXSweep` keeps its own
  `running` re-entrancy guard — those are exported and called directly by
  tests, so the guard is part of their contract, not the lifecycle's.
- Wire types live in `$lib/types/api.ts`, never in a `db/queries/*`
  module. A DTO imported from `$lib/server` by client-safe code
  type-checks and ships nothing, so nothing catches it — but it makes the
  browser's contract whatever a `SELECT` happens to project, with no
  boundary at which changing a query registers as changing an API. The
  media/gallery feature did exactly this; no client module imports from
  `$lib/server` now, and that's worth keeping true.
- Per-endpoint secrets use the `*_env` field convention in `config.toml`:
  the field stores the _name_ of an env var, never the secret itself.
- MCP servers are `auth = "global"` (one shared `api_key_env` token, the
  default) or `auth = "per_user"` (each user enters their own token in
  `/settings/mcp`, stored AES-256-GCM-encrypted, keyed `(serverId, userId)`).
  The encryption key is `MCP_SECRET_KEY`, which defaults to `AUTH_SECRET`
  (HKDF domain-separated, so reuse is safe) — set it only to rotate MCP
  encryption independently. Per-user tools can't ride the static tool registry —
  they register `isAvailable:false` and are appended per request by the
  message / tool-approval handlers (the same trick `activate_skill` uses).
  Per-user auth is HTTP-only.
- `await parent()` at the start of every `(app)` page server load. Without
  it the page's `locals.user!.id` deref races with the layout's
  redirect-on-no-auth and surfaces a 500 instead of a 302. **But it also
  couples the page to the layout's invalidation**: it sets SvelteKit's
  `uses.parent`, and a node whose parent re-ran is itself marked invalid — so
  a targeted `invalidate('app:conversations')` re-runs the page load too, and
  re-serializes everything it returns. A page with a big payload should
  instead guard with `requireUserPage(locals, url)` (`server/auth/guard.ts`),
  which reaches the layout's exact redirect from the layout's exact condition,
  so the race is benign. `chat/[id]` does this — it ships the whole active
  branch with `content_html`, and the coupling was making every completed turn
  _and_ every tab refocus refetch the entire conversation (measured 35 KB → 4 KB
  on a 40-turn thread; megabytes on a long code-heavy one). If you re-add
  `await parent()` there, that regresses silently.
- **Module singletons under `$lib/*.svelte.ts` may only be written from
  effects, event handlers, or functions those call** — never at
  component-init depth. `toast`, `confirmDialog`, `searchModal`,
  `privateView`, `streamPresence`, the `generating` / `title-pending` sets
  and the snippet cache are one instance per _server process_, shared by
  every concurrent request. Component init _does_ run during SSR, so a write
  at init depth publishes one user's state into another user's render;
  effects don't run on the server, which is the only reason the SSR copies
  stay empty. Context would enforce this structurally but doesn't fit here:
  several are page→layout publication channels (context flows down, not up),
  and `toast` is called from plain `.ts` modules where `getContext` is
  unavailable.
- `bits-ui` and `lucide-svelte` belong in `devDependencies` — Vite bundles
  them into the SSR build at compile time. Only packages that run
  server-side at request time (`drizzle-orm`, `shiki`, `markdown-it`,
  `smol-toml`) belong in `dependencies`. (SQLite needs no entry
  here — it's the built-in `node:sqlite`.)
- Component tests live under `tests/component/` and require a per-file
  `/* @vitest-environment happy-dom */` header — pure-logic unit tests
  default to `node`. See `tests/component/README.md` for the bits-ui
  Portal + `data-state` gotchas; forgetting them surfaces as DOM queries
  silently missing portaled content.
- **`pnpm lint` is `@sveltejs/eslint-config` + the full
  `recommendedTypeChecked`, and it is at zero — keep it there.** Every rule
  turned off in `eslint.config.js` carries its reason inline; three are
  load-bearing enough to restate:
  - `svelte/no-unused-svelte-ignore` **disagrees with the compiler**. It
    called three live `a11y_click_events_have_key_events` ignores unused,
    and deleting them made `pnpm check` warn again. `pnpm check` is the
    authority on which `svelte-ignore`s are live.
  - `require-await` can't see _contractual_ async — a function assigned to a
    `() => Promise<T>` type must be `async` even with nothing to await.
  - `unbound-method` + `no-unnecessary-type-assertion` are off **for
    `tests/` only** (`expect(obj.method)` never invokes the reference; a test
    double's assertion often shapes inference — see the sharp edge below).
    Both stay on for `src/`.
- **Never leave `$props()` unannotated in a page component.** A bare
  `let { data } = $props()` makes `data` `any` in a plain TS program, so
  every `data.foo` goes unchecked — and `svelte-check` hides it, because
  SvelteKit's route-aware inference types `data` for the language server.
  A typo'd field then type-checks clean and fails at runtime. Both forms in
  the tree are annotated and safe: the generated `PageData` / `LayoutData`
  (6 routes) and an inline `$props<{ data: … }>()` shape (11). Prefer
  `PageData` for new pages — it follows the load function instead of a
  hand-maintained duplicate — but converting the inline ones buys type
  safety they already have. Same for optional callback props
  (`onPick?: (c: FanoutColumn) => void`): ESLint's Svelte parser doesn't
  resolve those, so annotate the parameter at the call site.
- **Throw-less `error()` / `redirect()`.** SvelteKit 2 types both as
  `never` and throws internally — write `error(404, '…')`, not
  `throw error(404, '…')`. Control flow still narrows after the call.
- **Docs track user-facing features + config, not fixes.** `README.md` is a
  landing page + feature tour; `docs/<topic>.md` are the per-topic guides.
  Shipping a user-facing feature → add a line to the README feature tour; if
  it needs configuration → also add/update its `docs/` page and the
  `config.toml.example` / `.env.example` annotations. Infra, CI, build, deps,
  and bugfixes get no doc change. (Same rule applies to operator-facing
  behavior changes — e.g. a new auth/onboarding flow updates the relevant
  `docs/` page, not just `CLAUDE.md`.)

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

- **SQLite is the built-in `node:sqlite`, not better-sqlite3.** No native
  compile, so the Docker/CI stages need no C/C++ toolchain. Driver is
  `drizzle-orm/node-sqlite` (requires drizzle-orm v1, currently an RC).
  Pragmas are set via `db.exec('PRAGMA …')` (node:sqlite has no `.pragma()`
  helper). better-sqlite3 used to tag along as an unbuilt _optional peer_ of
  drizzle-orm; pnpm 11 no longer pulls it in, so it's absent from the tree
  and the lockfile entirely.
- **pnpm 11 + native modules**: install runs with `--ignore-scripts`, then
  the only package needing its build script run is esbuild (prebuilt Go
  binary, fetched not compiled): `pnpm install --frozen-lockfile
--ignore-scripts` then `pnpm rebuild esbuild`. sharp ships prebuilt musl
  binaries, so it needs no rebuild. Same in Docker; same in CI.
- **pnpm settings live in `pnpm-workspace.yaml`** (`overrides`,
  `allowBuilds`), not package.json's `pnpm` field — pnpm stopped reading
  that field and _silently ignores_ it, which is how the security
  overrides got disabled once already. It's not a monorepo; the file
  exists only to hold settings. Docker must `COPY` it alongside
  package.json/pnpm-lock.yaml or `--frozen-lockfile` fails on the
  overrides mismatch. `.npmrc` is auth/registry-only under pnpm 11 and
  everything else in it is ignored, so settings go here, not there.
- **pnpm 11 refuses packages published in the last 24h**
  (`minimumReleaseAge`, on by default — it's the "malicious version
  published twenty minutes ago" guard). So `pnpm update --latest` can
  resolve a version that then fails verification, and the error appears on
  every subsequent install because the check runs against the _lockfile_
  before resolution — which also means you can't fix it with another
  `pnpm add`/`update`. Lower the range in package.json, then
  `pnpm clean --lockfile && pnpm install`. Don't take pnpm's offer to
  auto-add the version to `minimumReleaseAgeExclude`; that's a permanent
  hole punched in the policy to dodge a problem that expires on its own.
- **`tsc` is TypeScript 7; `tsc6` is TypeScript 6.** Both are installed,
  as npm aliases. TS7 ships no programmatic API until 7.1, and
  svelte-check, svelte2tsx and typescript-eslint all `import 'typescript'`
  — so `node_modules/typescript` must stay v6. It's aliased to
  `@typescript/typescript6`, which re-exports the v6 API and renames its
  binary to `tsc6`; real `typescript@7` is aliased to `@typescript/native`
  and owns `tsc`. Installing both un-aliased does NOT work — each claims
  the `tsc` bin. So `pnpm check` checks `src/` with v6 (through
  svelte-check) and `scripts/` with the native compiler, and a bare `tsc`
  is not the compiler that gates `src/`. Collapse this back to a plain
  `typescript` dep once the tooling moves to the 7.1 API.
- **node:sqlite won't auto-promote a nested `db.transaction()` to a
  SAVEPOINT** the way better-sqlite3 did. A helper that opens its own
  `getDb().transaction()` while a caller already holds one throws "cannot
  start a transaction within a transaction". Helpers that run inside another
  transaction must take the caller's `tx` (`Tx` in `db/client.ts`) and
  operate on it; only `tx.transaction()` (on the tx object) emits a savepoint.
- **drizzle-kit v1 emits column `.unique()` as an inline table constraint**,
  not a standalone `UNIQUE INDEX` like v0 did. On an existing DB that diff is
  a destructive table rebuild for a no-op. Declare uniqueness as an explicit
  `uniqueIndex('<existing_name>')` in the table's index callback instead, so
  generate stays clean. Migration folders are now per-migration dirs
  (`<ts>_<name>/migration.sql`), converted from the old flat layout by
  `drizzle-kit up`.
- **Hand-authored migrations (FTS5 virtual tables, triggers, data backfills)
  are SQL-only — a `<ts>_<name>/migration.sql` with NO `snapshot.json`.** The
  runtime migrator (`drizzle-orm/node-sqlite/migrator`) reads only `migration.sql`,
  sorted by dir name, so a snapshot-less dir applies fine and createTestDb picks
  it up too. Do NOT copy a neighbouring `snapshot.json` into it: these v1
  snapshots have no `prevId` chain and `drizzle-kit generate` keys off snapshot
  _content_, so a duplicated snapshot reads as two siblings and aborts generate
  with "Non-commutative migrations detected". Virtual tables aren't in `schema.ts`
  anyway, so there's nothing for a snapshot to track. See
  `drizzle/*_media_prompt_search` for the clean pattern. (The older
  `*_message_search_index` does carry a `snapshot.json` — added by the
  `drizzle-kit up` flat→per-dir conversion — so it's not an example of this.)
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
- **Don't compress _static assets_ at the reverse proxy.** adapter-node has
  `precompress: true`, so they ship as `.br` + `.gz` on disk and sirv
  negotiates via `Accept-Encoding`. Re-compressing at the proxy
  double-compresses. **This does not extend to dynamic responses** — SSR HTML
  and `__data.json` are generated per request and are never precompressed, and
  they're the big ones (a long chat's payload dwarfs the JS bundle). Something
  must compress them: either the proxy, or `COMPRESS_DYNAMIC=1` (see
  `server/compression.ts`), which is off by default on the assumption the proxy
  is doing it. Read as blanket advice, this bullet used to leave both sides off.
- **Allowlist by numeric GitHub user ID, not username.** Usernames can be
  deleted and re-registered by someone else.
- **`schema.ts` must stay `$lib`-free.** It's loaded outside the Vite
  build — by drizzle-kit, the `import-owui` esbuild bundle, and
  Playwright's e2e `global-setup.ts` — none of which resolve the `$lib`
  alias. Import shared code into it with a relative path.
- **`eslint --fix` can silently break type-checking — use `pnpm lint:fix`,
  which type-checks afterwards.** `no-unnecessary-type-assertion` asks
  "does the receiver already accept this expression's type?" and does NOT
  model generic inference flowing _out_ of the argument. So for a generic
  receiver the assertion is redundant for assignability but load-bearing for
  what `T` infers as:

  ```ts
  vi.fn(() => null as unknown); // T = () => unknown
  vi.fn(() => null); // T = () => null  ← autofix does this
  ```

  The mock still compiles; the later `.mockReturnValue({…})` is what fails,
  in a different place. When this was first measured, applying it repo-wide
  produced 50 `svelte-check` errors across 11 files, and **`pnpm test` stayed
  green throughout** — vitest never type-checks. (Don't treat that count as
  current; it grows with `tests/`.) `--fix-type problem,layout` does exclude the
  rule, but 37 of typescript-eslint's 46 fixable rules are `suggestion`, so
  that throws away most of the useful fixes; running the type-check after
  the fix is the better guard. The rule is already off for `tests/`, where
  every instance of this lived.

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
