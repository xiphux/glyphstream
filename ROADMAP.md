# GlyphStream — Roadmap

Items deliberately deferred from v1 so the architecture stays informed by
future direction without v1 trying to do it all. Listed roughly in order of
expected priority, not time-bound.

## Near-term (v1.x)

- **Image attachments / multimodal input.** Three related capabilities,
  one feature:
  - Vision chat (send an image to a vision-capable text model alongside the
    prompt) — wrap user content as OpenAI's structured `content` array with
    `image_url` parts.
  - Image-to-image (`/v1/images/edits`) — multipart POST with the input
    image; bridge routes to ComfyUI workflows that have `image_inputs` in
    their meta.json.
  - Image-to-video (`/v1/videos` with `input_reference`) — same pattern,
    multipart POST with the reference image.

  Architecture: pre-upload pattern. New `POST /api/uploads` accepts a file,
  stores via the existing MediaStore, returns a `media_id`. The composer
  carries `attachedMediaIds: string[]`; on send, the message POST forwards
  the ids. The dispatcher branches on modelKind to compose the right
  upstream shape (content-array for chat / edits multipart / videos
  multipart). User-message rows get `image` parts referencing the
  uploaded media — same `message_media` ref-counting already in place.

  UI surface: file picker, drag-drop into composer, paste-from-clipboard,
  thumbnail preview with remove affordance, per-file upload progress.

  Estimate: ~1.5 focused days. Big enough to deserve its own chunk;
  unlocks I2V (one of the bridge's main value props) and vision chat.

- **Conversation import from Open WebUI.** User has existing chat history in
  OWUI to bring over. Format study + an importer that creates conversations,
  messages, and downloads referenced media into the local `MediaStore`.
  Worth doing reasonably early so v1 can fully replace OWUI for the user.

- **Message-tree branching UI.** Schema is already tree-shaped
  (`parent_message_id` + `conversations.active_leaf_message_id`). The v2
  work is purely UI: branch arrows on edited messages (`‹ 2/3 ›` style),
  branch-switch affordance, and changing the edit handler to create a new
  sibling instead of orphaning the old one. No data migration needed.

- **Message actions (full bar).** v1 ships with copy-to-clipboard only
  on each bubble; the action-bar shell is in place so the rest is
  pure plug-in work:
  - **Edit** (user messages): re-presents the message in the composer;
    on send, creates a sibling under the same parent and updates
    `active_leaf_message_id`. Tied to the branching-UI item above.
  - **Regenerate** (assistant messages): rolls back `active_leaf` to
    the preceding user message and re-dispatches. Different code paths
    per modality — chat re-streams, image/video re-call generation
    with the same prompt + params.
  - **Retry-on-error**: same as regenerate but only shown when the
    previous turn failed (network error, upstream 5xx, timeout).
  - **Branch nav**: `‹ 2/3 ›` indicator on messages with siblings, with
    affordance to switch active branch. Reuses the schema's tree shape.
  - **Thumbs up/down feedback**: requires a feedback collection
    surface — DB table + later UI for review/export. Lower priority
    until there's a workflow that actually consumes the feedback.

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
