# GlyphStream — Roadmap

Future work deliberately deferred from v1 so the architecture stays informed
by direction without v1 trying to do it all. Each item keeps its _why_ —
check here before starting a "wouldn't it be nice if…", the rationale is
probably already worked out. Listed roughly by priority within each tier, not
time-bound.

Completed work has been pruned. Where a shipped feature still has real
follow-on work, only the remaining piece is listed (with a one-line note on
what already shipped, for context).

## Mid-term (v2)

- **Agent skills (Anthropic skills spec).** A reusable capability bundle —
  a `SKILL.md` (name + description + body) plus optional resources — that
  loads into the model's context when the user's intent matches the
  description. Same ecosystem-extensibility story as MCP but a different
  layer: MCP adds _tools_, skills add _instructions + know-how_ for using
  existing tools. The two compose (a skill can declare which MCP tools it
  depends on). Open design points:
  - _Storage._ Per-user `skills` table keyed by `user_id`, body inline on
    the row, mirroring the rest of the schema.
  - _Activation._ Explicit via slash command (`/skill-name` in the composer)
    plus auto-trigger via description-matching on the user's turn. The
    auto-trigger threshold is the harder-than-it-looks part — false
    positives pollute the system prompt with irrelevant instructions.
  - _Script execution._ The spec lets skills ship scripts the agent runs;
    running arbitrary user code in the Node process is a non-starter. MVP is
    instructions-only — script execution delegates to whatever sandboxing an
    MCP server brings (see Open Terminal below).
  - _Discovery._ A browse/import affordance for community bundles, deferred
    until enough curated skills exist to anchor a library UI.

- **MCP — per-user OAuth + phase-2.** _Shipped:_ admin-defined
  `[[mcp_servers]]` with static auth (stdio + Streamable HTTP), tools
  namespaced into the registry with per-conversation + per-custom-model
  toggles, inline Allow/Always/Reject approval for untrusted tools, and
  `/settings/mcp` + `/settings/permissions` surfaces. Remaining:
  - _OAuth per-user (v1b)._ New `oauth_connections` table; multi-provider
    abstraction in `src/lib/server/auth/providers/` mirroring how arctic is
    wired for GitHub login; per-user `/settings/connections` UI with
    "Connect Gmail"-style affordances; `AUTH_SECRET`-keyed AES-256-GCM
    encryption-at-rest for refresh tokens (the env var is already defined in
    `.env.example` but unused). Sits beside the static-key path in the
    registry — no rework of v1.
  - _Browser-side bridge for user-local MCP servers_ (the `mcp-remote`
    pattern). The Node process can't reach a server on the user's laptop if
    GlyphStream is hosted elsewhere; a server-relayed WebSocket-to-browser
    transport closes that gap.
  - _Argument-aware approval._ v1 prompts per tool name; a policy engine
    could let users say "allow `delete_message` but only when `sender`
    matches X". The pending-approval row already persists args.
  - _Resources + prompts._ MCP servers can expose URI-addressable data and
    named prompt templates beyond tools — both out of scope for v1's
    tools-only cut.
  - _Rich content blocks in tool results._ Image/audio blocks are currently
    dropped with a placeholder note; relevant once Open Terminal lands and
    screenshot-style outputs become useful.

- **Memory — embedding-backed recall + phase-2.** _Shipped:_ browse-mode MVP
  (per-user `memories` table, `save`/`update`/`forget_memory` tools under
  `metadata.category: 'personalization'`, full-index injection into the
  system prompt so the model always has every memory without a retrieval
  round-trip, view+delete UI at `/settings/memories`). Remaining:
  - _Embedding-backed recall._ Schema already ships nullable `embedding` /
    `embedding_model` columns so backfill is a pure UPDATE. Adds a
    `recall_memory(query)` tool that activates when the endpoint advertises
    `supportsEmbeddings`. `composePersonaSystemPrompt` is marked
    `TODO(phase-2)` — swap inlined bodies for a recall-tool hint once memory
    count × avg tokens crosses a budget threshold (avoids the
    small-context-local-model blowup).
  - _Endpoint capability flag._ Add `supportsEmbeddings: boolean` to
    `LoadedEndpoint` (mirroring `supportsTools`), wired from `config.toml`.
    Drives both the recall-tool `isAvailable()` and the injection-mode
    switch.
  - _Backfill worker._ Reads rows where `embedding IS NULL`, calls the
    embedding endpoint, writes vectors back. No schema migration.
  - _Manual add/edit in UI._ If the AI-only feel grows limiting, add a
    textarea modal + `POST`/`PATCH /api/user/memories`.

- **Code interpreter — phase-2.** _Shipped:_ server-side Pyodide `run_python`
  built-in (one `worker_threads` worker per conversation with a
  ready/idle/failed lifecycle, idle-reap + LRU evict + wall-clock timeout;
  network shimmed through the same SSRF + per-conversation `web` gate as
  `fetch_url`; files round-trip with the conversation media store; worker
  bundled standalone via esbuild). Remaining:
  - _Streaming stdout._ Today's worker returns all stdout/stderr in one chunk
    at end of call, so a long-running cell feels frozen. The worker could
    `postMessage` per-line chunks → a new `tool_progress` SSE event → the
    in-flight tool block appends.
  - _Variable persistence across worker reaps._ Variables live only as long
    as the worker (lost on reap/timeout/OOM). Snapshot `globals()` via
    dill-style pickling to `data/code-interpreter/{conversationId}.bin`,
    restore on next call. Bounded by size + age, config-gated.
  - _Workspace UI._ A per-conversation files page/drawer surfacing everything
    under `/workspace/` for browse/preview/download/delete. Today the user
    only sees files via the chip on the producing tool block.
  - _micropip wheel cache._ A per-conversation/per-user override path under
    `data/code-interpreter/wheels/` so operators can pin a wheel set without
    round-tripping the CDN on cold start.
  - _Pre-warm pool._ Config flag `prewarm_workers = N` to spin up idle
    workers at boot so the first call doesn't pay the 2–5 s cold start.
  - _Per-tool-call approval (optional)._ Even sandboxed by construction, some
    users may want to see code before it runs — reuse the MCP approval
    infrastructure with a per-user trust list.

- **Inline RAG with embeddings.** Bridge already supports `/v1/embeddings`;
  GlyphStream can embed-and-retrieve attached docs/URLs and inject as system
  context. Particularly useful for chats grounded in personal notes.

- **Context compaction.** Summarize the conversation so far and continue from
  that summary as the new history. Mostly relevant for local LLMs — cloud
  providers ship 100k–1M tokens, but a llama.cpp run is often pinned at
  8k–32k and a long chat overflows. The manual workaround already works
  ("ask for a summary, paste into a new chat"), so this is ergonomics, not a
  missing capability. Sketch: a "Compact conversation" header action that
  runs the summarization through the conversation's _own_ main model (not the
  task model, which may be sized for short prompts and lose fidelity); output
  branches off the active leaf with the summary as a new root user message,
  and the tree-shaped schema preserves pre-compaction history (switch back
  via sibling-nav). Open question: user-triggered only, or auto-fire when a
  per-model context estimate crosses a threshold.

- **Multi-user.** Data model is already multi-user-shaped (every row has
  `user_id`); needs invite/admin UI + per-user resource-isolation tests + an
  admin role.

- **Virtualized message list.** Long conversations eventually overwhelm the
  DOM. `@tanstack/svelte-virtual` is the candidate; the hard part is the
  streaming case — the bottom message's height grows mid-stream, so the
  virtualizer re-measures on every chunk and the pin-to-bottom anchor tracks
  virtualized content height. Likely pattern: virtualize only historical
  messages, leave the streaming message in plain DOM until it completes.
  Trigger — implement when real conversations actually feel janky; below that
  threshold the measurement overhead can exceed just rendering everything.

- **DB-backed endpoint management UI** (instead of `config.toml` only). Add
  endpoints from a settings page; reload the registry without restart.

- **More OAuth providers** (Google, generic OIDC). `arctic` supports these.

- **S3-compatible media storage.** `MediaStore` is already the abstraction;
  implement `S3MediaStore` (Backblaze B2, Cloudflare R2, MinIO).

- **Postgres deployment option.** Drizzle is dialect-portable; needs a
  postgres-driver adapter and migration regeneration.

- **Bridge-side SSE normalization** (off by default via header). Saves
  duplicate normalizers if other clients ever consume the bridge.

- **Persistent agentic workspace (Open Terminal or equivalent).** A
  self-hosted shell + filesystem for long-running, multi-turn code tasks —
  clone a repo, modify files across turns, run tests, open a PR. Distinct
  from the code interpreter (the scratchpad-compute path); this is repo-style
  work needing state on a real disk with real tools. Listed late because the
  code interpreter covers many cases.

  Open Terminal (open-webui/open-terminal) is the most-developed candidate,
  but integration is more involved than "plug in as MCP": its MCP wrapper is
  a separate subcommand absent from the default Docker image; its richest
  capabilities (file sidebar, PTY terminal, port preview, upload) are
  REST-shaped and hidden from `/openapi.json`; and per-conversation isolation
  isn't built in (single-user mode shares `/home/user`). Two integration
  paths, in order of effort:
  - _OpenAPI → MCP translation in the registry._ Add an `openapi://...`
    transport mode that fetches a spec and registers each operation as a
    tool. Sidesteps the wrapper's packaging gaps and is generally useful (any
    OpenAPI-shaped sandbox works). This is the prereq for the lighter path.
  - _First-class "Open Terminal connection."_ Reimplements Open WebUI's
    connection mode (REST file sidebar, PTY tab, port preview). Much more
    work; only worth it if persistent workspaces become load-bearing.

  GlyphStream-side UX that applies either way: terminal/command outputs
  deserve their own bubble (monospace, collapsible, optional re-run) rather
  than the generic tool-call block; a per-conversation file explorer; and
  scope/quotas separate from per-call approval (directory allowlist +
  writable-area boundary persisting across a turn's tool chain).

## Long-term / nice-to-have

- **2FA (TOTP) on GitHub OAuth.** Passkey login already shipped as a peer
  primary method (the `userVerification: required` ceremony is itself
  multi-factor), so this is only about adding an authenticator-app TOTP layer
  to the GitHub side. Low priority — with a numeric-ID allowlist the
  GitHub-side attack surface is already narrow.

- **Voice input** via local Whisper (or the upstream `audio.transcriptions`
  endpoint once the bridge supports it).

- **Conversation export** (JSON / Markdown). Useful as an exit ramp, but the
  priority is building features that make users not want to leave.

- **Notification follow-ups.** _Shipped:_ Web Push (backgrounded
  tab/OS notification), in-app toast for a different thread, silent on the
  watched thread, native iOS Web Push (see `docs/notifications.md`).
  Remaining polish:
  - Optional completion sound, with volume control.
  - Per-modality config (e.g. "only sound for video"). The notify payload
    already carries `modality`; the SW just needs a per-modality routing
    pass.
  - A "your devices" UI surfacing `push_subscriptions.user_agent` with
    per-device revoke.

- **High-contrast / accessibility theme.** The themes system (Signature /
  Claude / ChatGPT, each light+dark, built on semantic tokens) shipped; a
  high-contrast scheme is the most practical additional theme beyond
  aesthetics. Deferred until the need arises.

- **Stored media dimensions (kill layout shift).** Image/video parts carry
  only `{ mediaId, alt }` — no intrinsic size — so the browser can't reserve
  space and media pops the layout when it loads: CLS on first render and in
  the lightbox, plus a jump-to-top when switching to a tall image branch
  (currently patched with a re-center-on-image-load in `selectSibling`).
  Capture width/height at generation / upload time, store on the media row,
  thread it into the image part, and set `aspect-ratio` on the `<img>`. Makes
  lazy-vs-eager loading irrelevant to layout and retires the re-center
  workaround.

- **Gallery favorite / pin tier.** A second-level distinction beyond "in the
  gallery vs. hard-deleted" — a favorite flag protecting media from any
  future bulk-cleanup sweep. A single boolean column + a lightbox star. The
  rationale only materializes once an automated bulk-cleanup affordance
  exists to protect favorites _from_.

- **Preference: default to deleting media when deleting conversations.** A
  single boolean on `UserPreferences`, read in the layout's
  `deleteConversation` flow to seed the modal's `deleteMediaToo` default.
  Saves a click for power users who reflexively want media gone — trivial to
  ship if demand shows up.

- **Background sync / offline composition.** Service worker queues messages
  while offline, resends on reconnect. Low priority — chat apps generally
  don't need this.
