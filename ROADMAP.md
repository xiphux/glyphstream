# GlyphStream — Roadmap

Items deliberately deferred from v1 so the architecture stays informed by
future direction without v1 trying to do it all. Listed roughly in order of
expected priority, not time-bound.

## Near-term (v1.x)

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

- **Additional per-conversation opt-out categories.** The composer's
  feature-toggle popover already ships with the **Web access** category
  (gating `web_search` + `fetch_url` together; see README's
  "Per-conversation feature toggles" section). The infrastructure —
  `disabled_features` column, category-aware tool registry, popover UI
  — generalizes to any future category by adding entries to
  `FEATURE_CATEGORIES` + per-tool `metadata.category` declarations.
  Concrete categories worth adding once their feature lands:
  - **Personalization** (system prompt / name / persona injection)
    — paired with the memory feature below.
  - **Memory writes** — once a `save_memory` tool exists, give users
    a switch that lets a conversation be read-only against memory.
  - **Per-MCP-server categories** — when MCP support lands, each
    connected server could expose its own category so a user can
    "use this server's tools" or "don't" at the conversation level.
  The "one unified toggle vs per-feature toggles" open question was
  answered by the user explicitly: per-feature, grouped by capability,
  with the priority that a switch must actually seal the threat it
  claims to (which is why web_search and fetch_url share one category
  instead of getting individual switches).

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

- **Playwright e2e suite — expand coverage.** The suite is stood up
  (`tests/e2e/`): it boots a production build against a mock OpenAI-
  compatible upstream (`fixtures/mock-upstream.mjs`, a second
  webServer) and walks the four high-value flows on both desktop and
  mobile — send a message, generate an image + regenerate from gallery
  (which exercises the gallery-launch `sessionStorage` handoff), edit a
  root message + verify it branches, and archive with Undo. Auth is
  covered via cookie-injected storageState plus an unauthenticated-
  redirect test. Still uncovered, and still manual-test territory
  because they need browser-*event* simulation rather than new flows:
  composer auto-resize after a programmatic text-set, iOS suspension
  recovery (`visibilitychange`), network-handoff recovery
  (`online`/`offline`), and the autoattach state machine on branch
  switches. Add these as a second tranche on top of the existing
  harness — emulate the visibility/connectivity events and assert the
  resulting recovery/resize, rather than driving a happy-path flow.

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
  MCP tools surface as standard tool calls and slot directly into the
  existing tool registry (`src/lib/server/tools/`). Architectural
  challenges remaining:
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
  conversations. Slots into the existing tool registry — memory access
  is tool-call-shaped. New `memories` table per `user_id`;
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

- **Animation polish pass — DONE** (Phase 2 of the theming work).
  Token-driven motion (`--motion-*` / `--ease-*` in `app.css`): a subtle
  pop-in (fade + drop) on the transient overlays (popovers, dropdowns,
  dialog cards, toast), an opacity-only message-arrival fade, and the
  streaming in-flight bubble fading in on stream start (the persisted row
  suppresses its own re-fade so the swap is seamless). Everything
  collapses to instant under `prefers-reduced-motion`. Not yet done:
  branch-switch crossfade and list-reorder motion — left out as the
  higher-risk bits near the scroll/streaming logic.

- **Regenerate response** as a separate action from edit.

- **Context compaction.** Pattern from Claude Code and other coding CLIs:
  summarize the conversation so far into a shorter representation, then
  continue with that summary as the new history. Mostly relevant for
  local LLMs — cloud providers ship 100k–1M tokens out of the box, but a
  llama.cpp run is often pinned at 8k–32k and a long chat eventually
  overflows. The manual workaround already works ("ask for a summary,
  paste into a new chat"), so this is about ergonomics, not a missing
  capability. Implementation sketch: a "Compact conversation" action on
  the chat header that runs the summarization through the conversation's
  *own* main model, not the task model — the task model may be sized for
  short prompts (title generation) and either not fit the full history
  or be a smaller/weaker model that loses fidelity on details the main
  model has been tracking. Output branches off the active leaf with the
  summary as the new root user message; the tree-shaped schema preserves
  the pre-compaction history automatically (no destructive migration),
  so the user can switch back via the sibling-nav arrows if they want
  the original thread. Open question: user-triggered only, or also
  auto-fired when per-model context-token estimate crosses a threshold
  (the token-usage surfacing from `0adaf0d` is the prereq for the
  latter).

- **Themes — DONE.** Three style *personalities* (not just palette
  swaps): **GlyphStream** Signature (neutral + liquid glass), **Claude**
  (warm paper, soft/large radii, clay accent), **ChatGPT** (cool grays,
  tight radii, flat, green accent). Each ships light + dark following
  `prefers-color-scheme`, selectable from Preferences. Built on the
  semantic-token migration this item flagged as the prereq; per-theme
  `[data-theme]` blocks override color + radius + shadow + glass.
  Applied before first paint via a non-httpOnly `gs-theme` cookie +
  `hooks.server.ts` `transformPageChunk` (no FOUC), reconciled against
  the DB pref after hydration. An explicit **light/dark/system override**
  also shipped: the dark cascade is attribute-driven (`data-scheme`,
  resolved before first paint by an inline script from the `gs-scheme`
  cookie or the OS), with a System/Light/Dark selector in Preferences.
  Deferred follow-ups:
  - **Per-theme dynamic `theme-color`** for the installed-PWA status bar
    (currently shows Signature's tint for all themes; doesn't follow a
    forced light/dark either).
  - **High-contrast / accessibility scheme** — the most practical
    additional theme beyond aesthetics.
