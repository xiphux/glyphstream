# GlyphStream — Roadmap

Future work deliberately deferred from v1 so the architecture stays informed
by direction without v1 trying to do it all. Each item keeps its _why_ —
check here before starting a "wouldn't it be nice if…", the rationale is
probably already worked out. Listed roughly by priority within each tier, not
time-bound.

This file tracks what's _left to do_. Shipped features are condensed to a
one-line "_Shipped:_" note for context only — the details live in the code and
docs. Where a shipped feature has real follow-on work, the remaining pieces
are listed in full.

## Mid-term (v2)

- **Agent skills (agentskills.io spec).** _Shipped (MVP):_ per-user skill
  bundles (bytes-on-disk + catalog table), progressive disclosure (Tier-1
  catalog → `activate_skill` → `read_skill_file`), import/enable/delete UI at
  `/settings/skills`, `/skill-name` explicit activation, and `run_skill_script`
  (Pyodide, Python-only, gated on the code interpreter). Remaining:
  - _Activation dedupe._ Re-activating a skill re-injects its body (wasteful,
    harmless; the catalog header already asks the model not to). True
    branch-aware dedupe scans persisted `activate_skill` tool messages via
    `conversationId`.
  - _Discovery._ A browse/import affordance for community bundles, deferred
    until enough curated skills exist to anchor a library UI.

- **MCP — per-user OAuth + phase-2.** _Shipped:_ admin-defined
  `[[mcp_servers]]` (stdio + Streamable HTTP), per-conversation +
  per-custom-model tool toggles, inline Allow/Always/Reject approval,
  `/settings/mcp` + `/settings/permissions`, and per-user static tokens
  (`auth = "per_user"`, AES-256-GCM-encrypted, keyed `(serverId, userId)`).
  HTTP-only. Remaining:
  - _OAuth per-user (v1b)._ The 3-legged OAuth flow (vs. the static token
    shipped). New `oauth_connections` table; multi-provider abstraction in
    `src/lib/server/auth/providers/` mirroring arctic's GitHub-login wiring;
    per-user `/settings/connections` UI with "Connect Gmail"-style
    affordances; `AUTH_SECRET`-keyed AES-256-GCM encryption-at-rest for refresh
    tokens. Sits beside the static-key path in the registry — no rework of v1.
  - _Browser-side bridge for user-local MCP servers_ (the `mcp-remote`
    pattern). The Node process can't reach a server on the user's laptop when
    GlyphStream is hosted elsewhere; a server-relayed WebSocket-to-browser
    transport closes that gap.
  - _Argument-aware approval._ v1 prompts per tool name; a policy engine could
    scope approval by argument ("allow `delete_message` but only when `sender`
    matches X"). The pending-approval row already persists args.
  - _Resources + prompts._ MCP's URI-addressable data + named prompt templates,
    beyond v1's tools-only cut.
  - _Rich content blocks in tool results._ Image/audio blocks are currently
    dropped with a placeholder note; relevant once Open Terminal lands and
    screenshot-style outputs become useful.

- **Memory — embedding-backed recall + phase-2.** _Shipped:_ browse-mode MVP
  (per-user `memories` table, `save`/`update`/`forget_memory` tools, full-index
  injection into the system prompt, view+delete UI at `/settings/memories`).
  Remaining:
  - _Embedding-backed recall._ Schema already ships nullable `embedding` /
    `embedding_model` columns so backfill is a pure UPDATE. Adds a
    `recall_memory(query)` tool that activates when the endpoint advertises
    `supportsEmbeddings`. `composePersonaSystemPrompt` is marked
    `TODO(phase-2)` — swap inlined bodies for a recall-tool hint once memory
    count × avg tokens crosses a budget threshold (avoids the
    small-context-local-model blowup).
  - _Endpoint capability flag._ Add `supportsEmbeddings: boolean` to
    `LoadedEndpoint` (mirroring `supportsTools`), wired from `config.toml`.
    Drives both the recall-tool `isAvailable()` and the injection-mode switch.
  - _Backfill worker._ Reads rows where `embedding IS NULL`, calls the
    embedding endpoint, writes vectors back. No schema migration.
  - _Manual add/edit in UI._ A textarea modal + `POST`/`PATCH
/api/user/memories`, if the AI-only feel grows limiting.
  - _Memory consolidation ("dreaming")._ A background pass that reorganizes
    accumulated memories the way sleep consolidates short- into long-term —
    deduping, and rewriting an old memory a later one revised. Gated on a
    change-watermark so it only fires when memories changed since the last pass.
    Reuses the existing `save`/`update`/`forget` primitives, driven by the
    conversation's own model on a background cadence (the media-purger pattern).
    Pairs with embedding-backed recall: consolidation is what keeps full-index
    injection from growing unboundedly as memory count × avg tokens climbs.

- **Code interpreter — phase-2.** _Shipped:_ server-side Pyodide `run_python`
  built-in (one `worker_threads` worker per conversation with idle-reap + LRU
  evict + wall-clock timeout; network through the SSRF + per-conversation `web`
  gate; files round-trip the conversation media store). Remaining:
  - _Streaming stdout._ Today's worker returns all stdout/stderr in one chunk
    at end of call, so a long-running cell feels frozen. The worker could
    `postMessage` per-line chunks → a new `tool_progress` SSE event → the
    in-flight tool block appends.
  - _Variable persistence across worker reaps._ Variables live only as long as
    the worker (lost on reap/timeout/OOM). Snapshot `globals()` via dill-style
    pickling to `data/code-interpreter/{conversationId}.bin`, restore on next
    call. Bounded by size + age, config-gated.
  - _Workspace UI._ A per-conversation files page/drawer surfacing everything
    under `/workspace/` for browse/preview/download/delete. Today the user only
    sees files via the chip on the producing tool block.
  - _micropip wheel cache._ A per-conversation/per-user override path under
    `data/code-interpreter/wheels/` so operators can pin a wheel set without
    round-tripping the CDN on cold start.
  - _Pre-warm pool._ Config flag `prewarm_workers = N` to spin up idle workers
    at boot so the first call doesn't pay the 2–5 s cold start.
  - _Per-tool-call approval (optional)._ Even sandboxed by construction, some
    users may want to see code before it runs — reuse the MCP approval infra
    with a per-user trust list.

- **Inline RAG with embeddings.** _Shipped (for web reads):_ `fetch_url` takes
  an optional `find` and, on over-budget pages, does hybrid relevance selection
  (structure-aware chunking with breadcrumbs + BM25 fused with embedding cosine
  via Reciprocal Rank Fusion) instead of head-truncation. Gated on an optional
  top-level `[embeddings]` config block; degrades to BM25-only when absent or
  on any embedding failure.

  Framing to keep in mind (from an architecture review): this feature
  compensates for a fixed small context budget, so its value is _highest_ on
  the small-context local LLMs this project targets and _lowest_ on frontier
  cloud models (where "the answer is past 20 KB" is better solved by just
  raising the budget — long-context beats RAG for a single doc that fits). And
  it's tuned for **needle-finding, not whole-doc synthesis**: disjoint chunks +
  ellipses give a fragmented view that's worse than contiguous truncation for
  "summarize this page".

  Remaining, roughly in priority order:
  - _Context-aware budget (the real lever)._ `MAX_CONTENT_CHARS` (and the
    relevance-trigger threshold) is one hard-coded value serving two very
    different regimes. Make it configurable — ideally per-endpoint/context — so
    a 200 K-context user rarely fragments while a local-8 K user gets
    aggressive selection. Caveat: doing this _per active model_ means giving
    the web tools access to the conversation's endpoint, which `ToolContext`
    deliberately doesn't carry today; a global config override is the cheap
    partial version.
  - _Return selected section breadcrumbs so the model can re-`find`._ Today a
    re-fetch with a new `find` flies blind — the model never learns which
    sections exist or what was elided. Surfacing breadcrumbs turns single-shot
    lookup into intelligent multi-hop. Ranked _above_ the embedding cache: it's
    an agency/quality lever, not just efficiency.
  - _Reranker — the biggest deferred quality jump._ Hybrid retrieve →
    cross-encoder or LLM rerank of the top ~15-20 → pack. Reranking is the
    largest reported incremental gain after hybrid retrieval, and there's a
    cheap path here: an LLM endpoint is already in hand and candidates are
    already ≤64, so an LLM-rerank is one extra call. Beats further RRF tuning.
  - _Apply to attached docs/URLs, not just `fetch_url`._ Embed-and-retrieve
    user-attached files / pasted notes and inject as system context.
  - _Reuse in `recall_memory`._ The memory phase-2 recall tool can import
    `vector.ts` + `embeddings()` + `loadEmbeddingsConfig()` directly.
  - _Smaller niceties._ Per-(url, model) embedding cache; tune batch sizing
    per backend.

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

- **Canvas / collaborative document mode.** A long-lived document the model
  edits across multiple turns and the user can edit too — a side-by-side
  artifact pane rather than inline chat messages — for work that needs several
  revisions before a final product (prose, a spec, a config), where re-pasting
  the whole document every turn is the friction. Distinct from the chat
  stream: the canvas is a _mutable artifact_, not an append-only message, so
  it wants its own entity + version chain rather than living on a message row.
  Sketch: an `artifacts` table (per-user, `conversation_id`-scoped) holding
  current content + a version history; the model edits via a diff/replace tool
  (`update_canvas`) so turns apply targeted edits instead of regenerating the
  whole doc; human edits append versions to the same chain so authorship
  interleaves. Markdown-first to start (reuse the server-side
  markdown-it + shiki pipeline). Open questions: reconcile with the
  tree-shaped message schema — does a canvas version pin to the leaf that
  produced it, so branch-nav restores the matching doc state?; conflict
  handling when human + model edit concurrently; whether to diff-render edits
  in the pane.

- **Multi-user.** _Shipped:_ `admin` role + invite flow (`/join/<token>`,
  OAuth or passkey), `/settings/admin` UI (list / invite / enable-disable /
  delete with last-admin + self-action guards), and per-user data-isolation
  hardening. Remaining nice-to-haves: a per-user storage-quota / usage view;
  bulk user import.

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

- **Unpin `drizzle-orm` / `drizzle-kit` off the 1.0 RC once 1.0 GA ships.**
  The node:sqlite migration pinned both to `1.0.0-rc.3` (exact, not a range)
  because node:sqlite support only exists on the drizzle v1 line. _Why
  pinned, not ranged:_ an RC can ship breaking changes between pre-releases,
  so a caret range would be a silent footgun; the exact pin + committed
  `pnpm-lock.yaml` (installed everywhere with `--frozen-lockfile`) keeps it
  deterministic. When 1.0 GA lands, move both to a normal `^1` range, re-run
  the suite + a toolchain-free docker boot, and revisit the better-sqlite3
  inert-peer note in CLAUDE.md (the optional-peer situation may change at GA).
  Tracking issue / changelog: drizzle-orm v1 release. Until then the RC must
  not silently become the permanent baseline.

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

- **Notification follow-ups.** _Shipped:_ Web Push, in-app toast for a
  different thread, silent on the watched thread, native iOS Web Push (see
  `docs/notifications.md`). Remaining polish:
  - Optional completion sound, with volume control.
  - Per-modality config (e.g. "only sound for video"). The notify payload
    already carries `modality`; the SW just needs a per-modality routing pass.
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

- **Optional cap on accumulated fan-out variations.** Media regenerate is
  additive (a re-roll adds a sibling beside the original rather than replacing
  it — see the keep-many compare grid), so repeated Regenerate-and-keep grows
  DB rows + stored media unbounded; the per-conversation cap only bounds
  _concurrent_ (in-flight) branches, not accumulated kept ones, and the purger
  only sweeps zero-ref media. This is deliberate ("keep whichever you prefer,
  discard the rest" — consistent with the app's general accumulate-media-then-
  prune model; the old destructive replace didn't bound total storage either).
  If unbounded growth ever bites a small self-hosted box, the fix is a
  total-sibling-per-fan-out cap (disable Regenerate past N kept variations) or
  a bulk-cleanup sweep — neither worth the friction pre-emptively.

- **Background sync / offline composition.** Service worker queues messages
  while offline, resends on reconnect. Low priority — chat apps generally
  don't need this.
