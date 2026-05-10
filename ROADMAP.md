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

- **User preferences + notifications / sounds.** No user-prefs surface
  exists in v1 — adding one unblocks several small QOL items (this one,
  personalization, enter-key behavior). Storage: a `user_preferences`
  table keyed on `user_id` with a JSON `prefs` column — small surface,
  fast to evolve without migrations. UI: a settings/preferences page
  alongside `settings/models`. First features filling it:
  - Toast on assistant message complete (foreground feedback)
  - Browser Notification API for backgrounded tab — especially valuable
    for multi-minute video generations
  - Optional completion sound, with volume + per-modality config (e.g.
    "only sound for video, since they take longest")
  - Silent when tab is focused; fire only when user has navigated away

  The PWA / service worker setup already in place means notifications can
  fire even with the app installed-but-closed on the iPhone homescreen.

- **Personalization (name, tone, about-me).** User-level system-prompt
  content that composes with per-conversation / per-custom-model prompts.
  Two flavors in the wild:
  - *Raw system prompt* (OWUI). User writes whatever; maximum power,
    weak discoverability — most users won't write a good one.
  - *Structured fields* (ChatGPT). Name, occupation, traits, response
    style → combined server-side into a system prompt at request time.
    Lower barrier to filling in, narrower expressiveness.

  Hybrid is best — structured fields for the common cases plus a free-form
  "anything else?" field for the long tail. Composition rule: user-level
  prompt prepends to (custom-model preset prompt or conversation default
  prompt) so per-conversation intent wins over standing context. Distinct
  from custom models, which are per-preset, not per-user. Lives in the
  prefs surface above.

- **Enter key behavior preference.** Two valid conventions: Enter-sends
  + Shift+Enter-newline (Slack / Discord DMs), or Enter-newline +
  Cmd/Ctrl+Enter-sends (Discord channels, IDEs, multiline editors). Pure
  preference — defensible either way; Enter-sends is faster for normal
  chat, Enter-newline is friendlier for code-heavy multiline messages.
  Adds a single boolean to user prefs. Default: Enter-sends, since it's
  the dominant chat-app convention.

- **Auto-generated conversation titles via a task model.** Standard UX is
  a side-call to a model after the first exchange asking it to summarize
  the conversation in a few words. Two flavors exist in the wild:
  - *Same model as the conversation* (ChatGPT, Claude.ai). Zero config
    but doesn't work for image / video / embedding conversations (no text
    generation), wastes premium tokens on a trivial task, and is slow if
    the chat model is a big reasoning model.
  - *Dedicated "task model" in config* (Open WebUI). One global
    small/cheap/fast model for utility tasks; always works regardless of
    the active conversation's modality.

  Task-model approach fits GlyphStream — most multimodal conversations
  here can't title themselves. Config: top-level `task_model =
  "endpoint_id::model_id"` in `config.toml`, matching the internal model
  ID format. Fire fire-and-forget after the first user+assistant exchange
  completes (for image/video, after the first generated asset arrives —
  the prompt itself is the input). Update `conversations.title`; surface
  to frontend via the existing SSE channel or a small refetch. Fallback
  when `task_model` is unset: first ~40 chars of the first user message.
  Worth treating the `task_model` config slot as the home for *all*
  future utility tasks (follow-up suggestions, retrieval query
  extraction, etc.), not just titles.

- **Gallery → conversations using this media.** Right now deleting a media
  item from the gallery leaves any referencing conversation as a "dead"
  prompt with no result. The media-detail view should list the conversations
  that reference this media (the `message_media` join table already carries
  the data), with click-through to each — so the user can clean up the
  orphan conversation rather than leave it lingering.

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

- **Model favoriting / pinning** in the picker.

- **Regenerate response** as a separate action from edit.
