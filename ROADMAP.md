# GlyphStream — Roadmap

Items deliberately deferred from v1 so the architecture stays informed by
future direction without v1 trying to do it all. Listed roughly in order of
expected priority, not time-bound.

## Near-term (v1.x)

- **Tool/function-call rendering UX.** Render tool invocations + results
  inline in messages, like Claude Code / Cursor do. Prerequisite for the
  next item.

- **Web search via SearxNG as auto-tool.** Register a `web_search` function
  tool with chat requests for tool-capable models; tool loop runs in the
  frontend (model emits `tool_call` → frontend executes against SearxNG →
  returns result → model continues). Per-model `supports_tools` flag needed
  in config. Avoids OWUI's manual "enable web search" toggle by letting the
  model decide when it needs to search.

- **Completion sounds + per-modality notification config.** Notifications
  themselves shipped — Web Push for backgrounded tab/OS notification, an
  in-app toast for "different thread, app still open," and silent on the
  thread you're watching (see `docs/notifications.md`). The remaining
  follow-ups all need per-user / per-modality toggles:
  - Optional completion sound, with volume control.
  - Per-modality config (e.g. "only sound for video, since they take
    longest"). The notify payload already carries `modality`; the SW just
    needs a per-modality routing pass on the client side.
  - A "your devices" UI surfacing the `push_subscriptions.user_agent`
    column with per-device revoke.

- **Per-conversation "private mode" toggle.** A conversation-row
  boolean (and a UI toggle when starting a chat) that opts out of all
  user-level personal-data injection — system prompt, future memories,
  future personalization fields. Use case: "throwaway question I don't
  want flavored by my standing context," similar in spirit to ChatGPT's
  Temporary Chats (though narrower — Temporary Chats also drop history,
  which we deliberately keep). Open design question: one unified toggle
  ("don't use any of my personal data here") vs. per-feature toggles
  ("disable system prompt only, keep memories"). Pick once we have
  memories implemented and can see which split feels right.

- **Bulk gallery management.** As the library accumulates over months
  of use, single-item delete becomes tedious. Worth adding multi-select
  + bulk-delete (and maybe bulk-archive into a hidden tier) once the
  pain is real — the library model commits the architecture to "users
  curate the gallery themselves," so the curation tools need to scale
  with library size. Selection state lives in the gallery page; the
  bulk-delete API can compose `hardDeleteMediaForUser` over the
  selection.

- **Gallery favorite / pin tier.** A second-level distinction beyond
  "in the gallery vs. hard-deleted" — media flagged as favorite is
  protected from any future bulk-cleanup affordances (e.g. an
  "archive media older than N months" sweep we might add later).
  Storage is a single boolean column on the media row plus a UI
  affordance in the lightbox (star icon next to download). Pairs
  naturally with bulk-management since the workflow is "select many,
  star the ones I care about, bulk-delete the rest."

- **Preference toggle: default to deleting media when deleting
  conversations.** Power users who generate hundreds of images per
  session and reflexively want them all gone afterward should be able
  to flip the conversation-delete dialog's checkbox default. Single
  boolean on `UserPreferences`; one-line read in the layout's
  `deleteConversation` flow when seeding the modal's initial
  `deleteMediaToo` value. Trivially shippable any time the demand
  shows up.

- **Playwright e2e suite.** `@playwright/test` is in devDependencies
  but no actual suite has been stood up. Several recent bug classes
  live entirely in browser-event territory and have been flagged as
  manual-test territory because unit-testing them would mostly test
  mocks rather than real behavior: gallery-launch `sessionStorage`
  handoff, composer auto-resize after a programmatic text-set, iOS
  suspension recovery (`visibilitychange`), network-handoff recovery
  (`online`/`offline`), the autoattach state machine on branch
  switches. A small Playwright suite — spinning up the dev server,
  walking through representative flows — covers exactly this gap.
  Worth scoping at a few high-value flows first (login + send a
  message, generate an image + regenerate from gallery, edit a root
  message and verify it branches, archive with Undo) rather than
  attempting exhaustive UI coverage.

## Mid-term (v2)

- **Virtualized message list.** Long conversations eventually overwhelm the
  DOM. `@tanstack/svelte-virtual` is the candidate; the nontrivial part is
  the streaming case — the bottom message's height grows mid-stream, so the
  virtualizer has to re-measure on every chunk and the pin-to-bottom anchor
  has to track virtualized content height (not DOM height). Pattern other
  chat apps converge on: virtualize only the historical messages, leave the
  streaming message in plain DOM until the stream completes. Trigger
  condition — implement when real-world conversations actually feel janky in
  production use; below that threshold the virtualizer's measurement
  overhead can exceed the cost of just rendering everything.

- **Multi-user.** Data model is multi-user-shaped (every row has `user_id`);
  needs invite/admin UI + per-user resource isolation tests + an admin role.

- **DB-backed endpoint management UI** (instead of `config.toml` only). Add
  endpoints from a settings page; reload registry without restart.

- **More OAuth providers** (Google, generic OIDC). `arctic` supports these.

- **Bridge-side SSE normalization** (off by default via header). Saves
  duplicate normalizers if other clients ever consume the bridge.

- **S3-compatible media storage.** `MediaStore` interface is already the
  abstraction; implement `S3MediaStore` (Backblaze B2, Cloudflare R2, MinIO).

- **Postgres deployment option.** Drizzle is dialect-portable; needs a
  postgres-driver adapter and migration regeneration.

- **Conversation export** (JSON / Markdown).

- **MCP server support.** Model Context Protocol gives clients a
  plug-and-play way to add tool servers — Gmail, Calendar, filesystem,
  GitHub, Linear — without GlyphStream having to build each integration.
  Depends on tool/function-call rendering UX (near-term) since MCP tools
  surface as standard tool calls. Architectural challenges:
  - *Transport.* MCP currently runs over stdio or SSE. Stdio doesn't
    translate to a web frontend; SSE works (the `mcp-remote` pattern).
    GlyphStream's Node process spawns / connects to MCP servers and
    surfaces their tools to chat requests as standard `tools` array
    entries — same loop pattern as web search.
  - *Auth.* Gmail / Calendar / GitHub need OAuth flows that survive
    across conversations. Per-user "connect <service>" affordance in
    prefs, with tokens stored encrypted in DB.
  - *Trust.* Arbitrary MCP servers can do arbitrary things. Need an
    approve-each-tool-call UX (like Claude Desktop) with per-server
    "always allow" promotion for trusted ones.

  High value once shipped: any of the dozens of public MCP servers
  becomes available in chat with zero GlyphStream-side integration code
  per service. Probably the single biggest user-facing capability
  expansion in v2 scope.

- **Memory system.** Tools for the model to read/write per-user memories —
  standing facts, preferences, ongoing context that should persist across
  conversations. Depends on tool/function-call rendering (near-term) since
  memory access is tool-call-shaped. New `memories` table per `user_id`;
  tools: `recall_memory(query)` for retrieval, `save_memory(text)` /
  `forget_memory(id)` for writes. Open question whether retrieval is
  keyword + recency or embedding-based — embeddings are more powerful but
  make the feature dependent on having an embedding model configured.
  Reasonable phasing: keyword/recency first, semantic recall later (which
  also unlocks inline RAG below).

- **Inline RAG with embeddings.** Bridge already supports `/v1/embeddings`;
  GlyphStream can embed-and-retrieve attached docs/URLs and inject as
  system context. Particularly useful for chats grounded in personal notes.

## Long-term / nice-to-have

- **2FA / passkeys.** Relevant once multi-user is on.

- **Voice input** via local Whisper (or upstream `audio.transcriptions`
  endpoint when the bridge supports it).

- **Background sync / offline composition.** Service worker queues messages
  while offline; resends when connectivity returns. Low priority — chat
  apps generally don't need this.

- **Animation polish pass.** Motion design is intentionally minimal
  today — the mobile drawer slides and that's about it. Toasts,
  dropdowns, message arrivals, and most state changes pop in
  instantly. A coordinated pass to add tasteful transitions
  (toast enter/exit, message-arrival fade, model-picker open,
  branch-switch crossfade, etc.) would noticeably lift perceived
  polish. Worth doing as one coherent pass rather than per-feature
  so timing curves and easing stay consistent across the app —
  otherwise each addition risks looking out of place against the
  no-animation baseline of everything else.

- **Regenerate response** as a separate action from edit.

- **Themes (prebuilt color schemes).** App follows
  `prefers-color-scheme` for light/dark today, with no explicit user
  toggle. Themes would add 3-5 named schemes selectable from
  Preferences — default, warm, cool, high-contrast as candidates.
  Each scheme applies a CSS custom-property palette at the document
  root; shiki already uses this pattern for dual-theme code blocks,
  so the precedent exists. Storage: a `theme` field on
  UserPreferences. Open design question: do themes pair with
  light/dark (each scheme has both variants, switched by
  `prefers-color-scheme`) or own the full palette (each scheme is
  one fixed look)? Former is more flexible, latter is simpler with
  ~2x the named options. Real prerequisite is migrating from
  hardcoded Tailwind `neutral-*` utilities to CSS-variable-backed
  semantic tokens (`bg-surface`, `text-primary`, etc.) — once that's
  in place the theme switch itself is a single root-level class
  change. High-contrast is the most practical case beyond aesthetics
  (accessibility for low-vision users).
