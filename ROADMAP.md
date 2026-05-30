# GlyphStream — Roadmap

Items deliberately deferred from v1 so the architecture stays informed by
future direction without v1 trying to do it all. Listed roughly in order of
expected priority, not time-bound.

## Mid-term (v2)

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
  `forget_memory(id)` for writes. The recall/save tools should declare
  `metadata.category: 'personalization'` so the existing per-conversation
  toggle (which already gates the prefs-derived persona system prompt)
  also seals memory reads/writes — both are avenues that ship personal
  context to the model, so flipping the switch should close all of them.
  Open question whether retrieval is keyword + recency or embedding-based —
  embeddings are more powerful but make the feature dependent on having
  an embedding model configured. Reasonable phasing: keyword/recency
  first, semantic recall later (which also unlocks inline RAG below).

- **Inline RAG with embeddings.** Bridge already supports `/v1/embeddings`;
  GlyphStream can embed-and-retrieve attached docs/URLs and inject as
  system context. Particularly useful for chats grounded in personal notes.

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

- **Multi-user.** Data model is multi-user-shaped (every row has `user_id`);
  needs invite/admin UI + per-user resource isolation tests + an admin role.

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

- **DB-backed endpoint management UI** (instead of `config.toml` only). Add
  endpoints from a settings page; reload registry without restart.

- **More OAuth providers** (Google, generic OIDC). `arctic` supports these.

- **S3-compatible media storage.** `MediaStore` interface is already the
  abstraction; implement `S3MediaStore` (Backblaze B2, Cloudflare R2, MinIO).

- **Postgres deployment option.** Drizzle is dialect-portable; needs a
  postgres-driver adapter and migration regeneration.

- **Bridge-side SSE normalization** (off by default via header). Saves
  duplicate normalizers if other clients ever consume the bridge.

## Long-term / nice-to-have

- **2FA / passkeys.** Relevant once multi-user is on.

- **Voice input** via local Whisper (or upstream `audio.transcriptions`
  endpoint when the bridge supports it).

- **Conversation export** (JSON / Markdown). Useful as an exit ramp,
  but the priority is building features that make users not want to
  leave rather than making it easier to do so.

- **Completion sounds + per-modality notification config.** Notifications
  themselves shipped — Web Push for backgrounded tab/OS notification, an
  in-app toast for "different thread, app still open," and silent on the
  thread you're watching (see `docs/notifications.md`). Native iOS Web
  Push covers the standard notification behavior; the follow-ups below
  are polish on top:
  - Optional completion sound, with volume control.
  - Per-modality config (e.g. "only sound for video, since they take
    longest"). The notify payload already carries `modality`; the SW just
    needs a per-modality routing pass on the client side.
  - A "your devices" UI surfacing the `push_subscriptions.user_agent`
    column with per-device revoke.

- **Gallery favorite / pin tier.** A second-level distinction beyond
  "in the gallery vs. hard-deleted" — media flagged as favorite would be
  protected from any future bulk-cleanup affordances (e.g. an
  "archive media older than N months" sweep). Storage is a single
  boolean column on the media row plus a UI affordance in the lightbox
  (star icon next to download). Pairs naturally with bulk-management,
  but the rationale only really materializes once an automated
  bulk-cleanup affordance exists to protect favorites *from* — which
  isn't itself on the roadmap.

- **Preference toggle: default to deleting media when deleting
  conversations.** Single boolean on `UserPreferences`; one-line read
  in the layout's `deleteConversation` flow when seeding the modal's
  initial `deleteMediaToo` value. Saves one click per delete for power
  users who reflexively want media gone — trivial to ship if the demand
  shows up, but low value otherwise.

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

- **Themes — DONE.** Three style *personalities* (not just palette
  swaps): **GlyphStream** Signature (neutral + frosted glass), **Claude**
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
  cookie or the OS), with a System/Light/Dark selector in Preferences. The
  PWA `theme-color` tracks the active theme + scheme as well. Only
  remaining follow-up, deferred until the need arises: a **high-contrast /
  accessibility scheme** — the most practical additional theme beyond
  aesthetics.
