# GlyphStream — Roadmap

Items deliberately deferred from v1 so the architecture stays informed by
future direction without v1 trying to do it all. Listed roughly in order of
expected priority, not time-bound.

## Near-term (v1.x)

- **Conversation import from Open WebUI.** User has existing chat history in
  OWUI to bring over. Format study + an importer that creates conversations,
  messages, and downloads referenced media into the local `MediaStore`.
  Worth doing reasonably early so v1 can fully replace OWUI for the user.

- **Message-tree branching UI.** Schema is already tree-shaped
  (`parent_message_id` + `conversations.active_leaf_message_id`). The v2
  work is purely UI: branch arrows on edited messages (`‹ 2/3 ›` style),
  branch-switch affordance, and changing the edit handler to create a new
  sibling instead of orphaning the old one. No data migration needed.

- **Tool/function-call rendering UX.** Render tool invocations + results
  inline in messages, like Claude Code / Cursor do. Prerequisite for the
  next item.

- **Web search via SearxNG as auto-tool.** Register a `web_search` function
  tool with chat requests for tool-capable models; tool loop runs in the
  frontend (model emits `tool_call` → frontend executes against SearxNG →
  returns result → model continues). Per-model `supports_tools` flag needed
  in config. Avoids OWUI's manual "enable web search" toggle by letting the
  model decide when it needs to search.

## Mid-term (v2)

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
