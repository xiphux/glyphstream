# GlyphStream — Roadmap

Items deliberately deferred from v1 so the architecture stays informed by
future direction without v1 trying to do it all. Listed roughly in order of
expected priority, not time-bound.

## Mid-term (v2)

- **MCP server support — v1 DONE.** Admin-defined `[[mcp_servers]]`
  blocks in `config.toml` mirror the existing endpoint pattern with
  static auth (none or `Authorization: Bearer ${env[api_key_env]}`).
  Both stdio and Streamable HTTP transports are wired; stdio
  connections eagerly connect at boot, reap after `idle_timeout_seconds`
  of inactivity, and re-spawn transparently on the next tool call. One
  failed server doesn't block the others — failures surface in
  `/settings/mcp` and the rest of the boot continues. MCP tools register
  into the existing tool registry under namespaced `mcp__<server>__<tool>`
  names with `metadata.category = mcp:<server-id>`, so per-conversation
  toggles and per-custom-model defaults handle them through the same
  paths as built-ins. Untrusted MCP tools halt the streaming relay with
  an inline Allow / Allow Always / Reject prompt; the resume endpoint
  re-issues the upstream call once decisions land. Per-tool "always
  allow" grants live at `/settings/permissions` — the cross-cutting
  permissions surface skills and Open Terminal will plug into next.
  Phase-2 work remaining:
  - *OAuth per-user (v1b).* New `oauth_connections` table; multi-provider
    abstraction in `src/lib/server/auth/providers/` mirroring how arctic
    is wired for GitHub login today; per-user `/settings/connections` UI
    with "Connect Gmail" affordances; `AUTH_SECRET`-keyed AES-256-GCM
    encryption-at-rest for refresh tokens (the env var is already defined
    in `.env.example` but currently unused). The OAuth path will sit
    beside the v1 static-key path in the registry with no rework of v1.
  - *Browser-side bridge for user-local MCP servers* (the `mcp-remote`
    pattern). The Node process can't reach a server running on the
    user's laptop if GlyphStream is hosted elsewhere; a server-relayed
    WebSocket-to-browser transport closes that gap.
  - *Argument-aware approval.* v1 prompts per tool name; a future policy
    engine could let users say "allow `delete_message` but only when
    `sender` matches X". The pending-approval row already persists args.
  - *Resources + prompts.* MCP servers can expose URI-addressable data
    and named prompt templates beyond tools — both are deliberately out
    of scope for v1's tools-only cut.
  - *Rich content blocks in tool results.* Image / audio blocks are
    currently dropped with a placeholder note; relevant once Open
    Terminal lands and screenshot-style outputs become useful.

- **Agent skills (Anthropic skills spec).** A skill is a reusable
  capability bundle — a `SKILL.md` (name + description + body) plus
  optional resources — that loads into the model's context when the
  user's intent matches the description. Same ecosystem-extensibility
  story as MCP but on a different layer: MCP adds *tools*, skills add
  *instructions + know-how* for using existing tools. The two compose
  (a skill can declare which MCP tools it depends on). Architectural
  challenges:
  - *Storage.* Per-user `skills` table keyed by `user_id`, mirroring
    the rest of the schema. Skill body inline on the row.
  - *Activation.* Explicit via slash command (`/skill-name` in the
    composer) and auto-trigger via description-matching on the user's
    turn. Auto-trigger needs care — false positives pollute the system
    prompt with irrelevant instructions; threshold-tuning is the
    harder-than-it-looks part.
  - *Script execution.* The spec lets skills ship scripts the agent
    runs. For a self-hosted web app that's a substantial sandboxing
    surface — running arbitrary user-provided code in the Node process
    is a non-starter. MVP is instructions-only; script execution
    delegates to whatever sandboxing an MCP server brings (the
    **Open Terminal** item below).
  - *Discovery.* A browse/import affordance for community skill
    bundles, deferred until enough curated skills exist to anchor a
    library UI.

- **Memory system — browse-mode MVP DONE.** Per-user `memories` table
  plus `save_memory` / `update_memory` / `forget_memory` tools, all
  declaring `metadata.category: 'personalization'` so the existing
  per-conversation toggle seals both the persona prompt and memory
  access in one switch. Browse mode injects every memory's body into
  the system prompt so the model always has the full index without a
  retrieval round-trip — works for every deployment regardless of
  upstream embedding support. Management UI at `/settings/memories` is
  view + delete only (locked-in MVP scope; manual add/edit is a
  follow-up if demand shows up). Phase-2 work remaining:
  - *Embedding-backed recall.* Schema already ships nullable
    `embedding` / `embedding_model` columns so backfill is a pure
    UPDATE. Adds a `recall_memory(query)` tool that activates when
    the endpoint advertises `supportsEmbeddings`. The injection branch
    in `composePersonaSystemPrompt` is marked with a `TODO(phase-2)`
    — swap inlined bodies for a recall-tool hint when memory count ×
    avg description tokens crosses a budget threshold or embeddings
    are available. Avoids the small-context-local-model blowup.
  - *Endpoint capability flag.* Add `supportsEmbeddings: boolean` to
    `LoadedEndpoint` (mirroring `supportsTools`), wired from
    `config.toml`. Drives both the recall-tool `isAvailable()` and
    the injection-mode switch above.
  - *Backfill worker.* Reads rows where `embedding IS NULL`, calls
    the embedding endpoint, writes vectors back. No schema migration.
  - *Manual add/edit in UI.* If the curated/AI-only feel grows
    limiting, surface a textarea modal on the settings page +
    `POST` / `PATCH /api/user/memories` endpoints.

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

- **Open Terminal (open-webui/open-terminal).** Self-hosted terminal
  + working-directory environment for the agent, exposed as an MCP
  server — Open WebUI uses it to give chat sessions a sandboxed code
  environment. Once the **MCP server support** item ships, plugging
  Open Terminal in is "just another MCP endpoint" and the core
  capability comes along for free. The remaining work is GlyphStream-
  side UX polish that improves on the generic tool-call rendering:
  - Terminal/command outputs deserve their own bubble treatment
    (monospace, collapsible, optional re-run button) rather than the
    generic tool-call block.
  - A files panel surfacing the agent's working directory — browse,
    preview, download. Effectively a per-conversation scoped file
    explorer.
  - Scope/quotas separate from MCP's per-call approval — directory-
    level allowlist + writable-area boundary that persist across the
    chain of tool calls within one turn.

  Prereq is the MCP item, not direct integration work here. Listed
  late in v2 because the value-over-baseline-MCP is incremental polish,
  not a new capability.

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
