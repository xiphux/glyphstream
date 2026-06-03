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
  - _OAuth per-user (v1b)._ New `oauth_connections` table; multi-provider
    abstraction in `src/lib/server/auth/providers/` mirroring how arctic
    is wired for GitHub login today; per-user `/settings/connections` UI
    with "Connect Gmail" affordances; `AUTH_SECRET`-keyed AES-256-GCM
    encryption-at-rest for refresh tokens (the env var is already defined
    in `.env.example` but currently unused). The OAuth path will sit
    beside the v1 static-key path in the registry with no rework of v1.
  - _Browser-side bridge for user-local MCP servers_ (the `mcp-remote`
    pattern). The Node process can't reach a server running on the
    user's laptop if GlyphStream is hosted elsewhere; a server-relayed
    WebSocket-to-browser transport closes that gap.
  - _Argument-aware approval._ v1 prompts per tool name; a future policy
    engine could let users say "allow `delete_message` but only when
    `sender` matches X". The pending-approval row already persists args.
  - _Resources + prompts._ MCP servers can expose URI-addressable data
    and named prompt templates beyond tools — both are deliberately out
    of scope for v1's tools-only cut.
  - _Rich content blocks in tool results._ Image / audio blocks are
    currently dropped with a placeholder note; relevant once Open
    Terminal lands and screenshot-style outputs become useful.

- **Agent skills (Anthropic skills spec).** A skill is a reusable
  capability bundle — a `SKILL.md` (name + description + body) plus
  optional resources — that loads into the model's context when the
  user's intent matches the description. Same ecosystem-extensibility
  story as MCP but on a different layer: MCP adds _tools_, skills add
  _instructions + know-how_ for using existing tools. The two compose
  (a skill can declare which MCP tools it depends on). Architectural
  challenges:
  - _Storage._ Per-user `skills` table keyed by `user_id`, mirroring
    the rest of the schema. Skill body inline on the row.
  - _Activation._ Explicit via slash command (`/skill-name` in the
    composer) and auto-trigger via description-matching on the user's
    turn. Auto-trigger needs care — false positives pollute the system
    prompt with irrelevant instructions; threshold-tuning is the
    harder-than-it-looks part.
  - _Script execution._ The spec lets skills ship scripts the agent
    runs. For a self-hosted web app that's a substantial sandboxing
    surface — running arbitrary user-provided code in the Node process
    is a non-starter. MVP is instructions-only; script execution
    delegates to whatever sandboxing an MCP server brings (the
    **Open Terminal** item below).
  - _Discovery._ A browse/import affordance for community skill
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
  - _Embedding-backed recall._ Schema already ships nullable
    `embedding` / `embedding_model` columns so backfill is a pure
    UPDATE. Adds a `recall_memory(query)` tool that activates when
    the endpoint advertises `supportsEmbeddings`. The injection branch
    in `composePersonaSystemPrompt` is marked with a `TODO(phase-2)`
    — swap inlined bodies for a recall-tool hint when memory count ×
    avg description tokens crosses a budget threshold or embeddings
    are available. Avoids the small-context-local-model blowup.
  - _Endpoint capability flag._ Add `supportsEmbeddings: boolean` to
    `LoadedEndpoint` (mirroring `supportsTools`), wired from
    `config.toml`. Drives both the recall-tool `isAvailable()` and
    the injection-mode switch above.
  - _Backfill worker._ Reads rows where `embedding IS NULL`, calls
    the embedding endpoint, writes vectors back. No schema migration.
  - _Manual add/edit in UI._ If the curated/AI-only feel grows
    limiting, surface a textarea modal on the settings page +
    `POST` / `PATCH /api/user/memories` endpoints.

- **Code interpreter (server-side Pyodide) — v1 DONE.** A `run_python`
  built-in tool in a new `code_interpreter` feature category. Pyodide
  runs in `node:worker_threads` (one worker per active conversation,
  state-machine lifecycle mirroring the MCP registry: ready / starting /
  idle / failed, idle-reaped after 5 min, LRU-evicted at the pool cap,
  wall-clock timeout terminates stuck workers, OOM exit propagates as a
  recoverable model error, SIGINT/SIGTERM shutdown reaps cleanly).
  Python's network access (`pyodide.http.pyfetch`, `urllib`, `requests`,
  `micropip`) goes through a `globalThis.fetch` shim installed before
  Pyodide loads — applies the same SSRF + configured-backend block as
  the `fetch_url` tool (extracted into `url-policy-base.ts` so the
  esbuild-bundled worker can pick it up without dragging in the
  SvelteKit env layer), AND honors the per-conversation `web` toggle
  so disabling it for the conversation blocks the agent's Python
  network too — micropip rides on the same gate. Files round-trip
  with the conversation media store: user-uploaded files (any kind)
  and earlier-turn Python outputs (origin='generated' +
  sourceModel='run_python') materialize into `/workspace/` before each
  call; new / modified files Python writes during the call get
  persisted as `origin='generated', sourceModel='run_python'` media
  and surface as inline previews / download chips in the tool block
  (chips rendered outside the collapsible `<details>` so the artifact
  stays visible even when args + result are collapsed). The worker
  bundles standalone via `esbuild` (run by `pnpm build:worker` as a
  pre-step of both `pnpm dev` and `pnpm build`) so Node's
  `worker_threads` can load it directly. Phase-2 work remaining:
  - _Streaming stdout._ Today's worker captures all stdout / stderr
    and returns it in one chunk at end of call. A long-running cell
    (training loop, batched data processing) feels frozen for the
    duration. The worker could `postMessage` per-line chunks; the
    relay forwards them as a new `tool_progress` SSE event; the
    in-flight tool block appends.
  - _Variable persistence across worker reaps._ Variables today live
    only as long as the worker (lost on idle reap, timeout-terminate,
    OOM). Pyodide can serialize the interpreter's `globals()` via
    `dill`-style pickling — snapshot to
    `data/code-interpreter/{conversationId}.bin`, restore on next
    call. Bounded by size + age, config-gated.
  - _Workspace UI._ A per-conversation files page / drawer surfacing
    everything under `/workspace/` for browse / preview / download /
    delete. Today the user only sees files via the chip on the tool
    block that produced them.
  - _micropip wheel cache._ Pyodide already auto-caches wheels into
    `node_modules` on first fetch from the CDN, but a per-conversation
    or per-user override path under `data/code-interpreter/wheels/`
    would let operators pin a specific wheel set without round-
    tripping the CDN every cold start.
  - _Pre-warm pool on startup._ Config flag `prewarm_workers = N` to
    spin up N idle workers at boot so the first per-conversation
    call doesn't pay the 2–5 s cold start.
  - _Per-tool-call approval (optional)._ Even sandboxed by
    construction, some users may want to see code before it runs.
    The existing MCP approval infrastructure could be reused with a
    per-user trust list.

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
  _own_ main model, not the task model — the task model may be sized for
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

- **Persistent agentic workspace (Open Terminal or equivalent).**
  Self-hosted shell + filesystem environment for long-running,
  multi-turn code tasks — clone a repo, modify files across turns,
  run tests, open a PR. Distinct from the server-side code interpreter
  (which is the scratchpad-compute path); this is for repo-style work
  where state needs to persist on a real disk with real tools.

  Open Terminal (open-webui/open-terminal) is the most-developed
  candidate, but integration is meaningfully more involved than "just
  plug in as MCP":
  - _Their MCP wrapper is awkward to ship in containers._ MCP is a
    separate `open-terminal mcp` subcommand whose `[mcp]` extras
    aren't installed in the default Docker image. Users would need a
    custom image (or override CMD) to use it.
  - _The richest Open Terminal capability is REST-shaped, not MCP-
    shaped._ The file sidebar, PTY terminal tab, port detection /
    reverse proxy, and multipart upload all live behind
    `include_in_schema=False` — they're absent from `/openapi.json`
    and therefore absent from the FastMCP tool surface too. Open
    WebUI's "Open Terminal connection" drives the REST API directly +
    makes browser-side calls to the hidden endpoints for the sidebar
    / terminal / preview UI; that's where the integration value comes
    from.
  - _Per-conversation isolation isn't built in._ Single-user mode
    shares `/home/user` across all sessions; `x-session-id` is a
    cwd hint, not a boundary. Multi-device-same-user or future
    multi-user can have conversations clobber each other's working
    trees. Hardening exists (multi-user mode → per-Linux-user
    isolation; bwrap-per-call → per-conversation seal; gVisor/Kata
    as runtime → stronger boundary) but none of it is upstream
    out-of-the-box.

  Two integration paths exist, in order of effort:
  - _OpenAPI → MCP translation in the registry._ Extend the MCP
    transport types with an `openapi://...` mode that fetches a spec
    and registers each operation as a tool — the same translation
    Open WebUI does. Sidesteps the upstream MCP wrapper's packaging
    gaps, and is a generally useful capability (any OpenAPI-shaped
    sandbox works, not just Open Terminal).
  - _First-class "Open Terminal connection."_ Reimplements what
    Open WebUI's connection mode does: REST-driven file sidebar,
    PTY terminal tab, port preview. Substantially more work; only
    worth doing if persistent workspaces become load-bearing.

  GlyphStream-side UX polish that applies to either path:
  - Terminal/command outputs deserve their own bubble treatment
    (monospace, collapsible, optional re-run button) rather than the
    generic tool-call block.
  - A files panel surfacing the agent's working directory — browse,
    preview, download. Effectively a per-conversation scoped file
    explorer.
  - Scope/quotas separate from MCP's per-call approval — directory-
    level allowlist + writable-area boundary that persist across the
    chain of tool calls within one turn.

  Prereq is the OpenAPI-translation extension (lighter path) or a
  dedicated connection layer (heavier). Listed late in v2 because for
  many cases the server-side code interpreter covers the need; this
  item is specifically about long-lived repo-style work the
  interpreter can't do.

## Long-term / nice-to-have

- **2FA layered on GitHub OAuth.** Passkey login shipped as a peer
  primary method (Settings → Security) — the `userVerification: required`
  ceremony is itself multi-factor, so this entry is only about adding an
  authenticator-app TOTP layer to the GitHub side. Low priority — for a
  self-hosted instance with a numeric-ID allowlist, the GitHub-side
  attack surface is already narrow.

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
  bulk-cleanup affordance exists to protect favorites _from_ — which
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

- **Themes — DONE.** Three style _personalities_ (not just palette
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
