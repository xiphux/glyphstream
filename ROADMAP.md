# GlyphStream — Roadmap

Work deliberately deferred so the architecture stays informed by direction
without v1 trying to do it all. Each item keeps its _why_ — check here before
starting a "wouldn't it be nice if…", the rationale is probably already worked
out. Roughly priority-ordered within each tier, not time-bound.

This file tracks what's _left to do_. Shipped features are mentioned only where
a one-line recap grounds the remaining work — the details live in the code and
docs.

## Mid-term (v2)

- **Agent skills (agentskills.io spec).** The MVP shipped (per-user bundles,
  progressive disclosure, import/enable/delete UI, `run_skill_script` on
  Pyodide). Remaining:
  - _Activation dedupe._ Re-activating a skill re-injects its body (wasteful,
    harmless). True branch-aware dedupe scans persisted `activate_skill` tool
    messages via `conversationId`.
  - _Discovery._ A browse/import affordance for community bundles — deferred
    until enough curated skills exist to anchor a library UI.

- **MCP — per-user OAuth + phase-2.** Admin-defined servers, per-tool toggles,
  inline approval, per-user static (encrypted) tokens, and deferred tool
  loading all shipped; HTTP-only. Remaining:
  - _OAuth per-user._ The 3-legged flow (vs. the static token shipped). New
    `oauth_connections` table; multi-provider abstraction in
    `src/lib/server/auth/providers/` mirroring arctic's GitHub-login wiring;
    per-user `/settings/connections` UI with "Connect Gmail"-style affordances;
    `AUTH_SECRET`-keyed AES-256-GCM encryption for refresh tokens. Sits beside
    the static-key path — no rework of v1.
  - _Browser-side bridge for user-local MCP servers_ (the `mcp-remote`
    pattern). The Node process can't reach a server on the user's laptop when
    GlyphStream is hosted elsewhere; a server-relayed WebSocket-to-browser
    transport closes that gap.
  - _Argument-aware approval._ A policy engine to scope approval by argument
    ("allow `delete_message` but only when `sender` matches X") vs. today's
    per-tool-name prompt. The pending-approval row already persists args.
  - _Resources + prompts._ MCP's URI-addressable data + named prompt templates,
    beyond the tools-only cut.
  - _Rich content blocks in tool results._ Image/audio blocks are currently
    dropped with a placeholder; relevant once Open Terminal lands and
    screenshot-style outputs become useful.
  - _Tool-search follow-ons._ Cache catalog embeddings across searches (stable
    catalog → embed only the query after warmup); a global
    `auto_defer_tool_threshold` to auto-defer any server past N tools; surface
    the deferred catalog in `/settings/mcp` so operators see what's hidden
    behind `search_tools`.

- **Memory — phase-2.** Browse-mode MVP and embedding-backed recall both
  shipped (keyed off the global `[embeddings]` block). Remaining:
  - _Manual add/edit in UI._ A textarea modal + `POST`/`PATCH
/api/user/memories`, if the AI-only feel grows limiting.
  - _Memory consolidation ("dreaming")._ A background pass that reorganizes
    accumulated memories the way sleep consolidates short- into long-term —
    deduping, rewriting an old memory a later one revised. Gated on a
    change-watermark so it only fires when memories changed since the last pass.
    Reuses the `save`/`update`/`forget` primitives, driven by the conversation's
    own model on a background cadence (the media-purger pattern). Pairs with
    recall: consolidation is what keeps full-index injection from growing
    unboundedly as memory count × avg tokens climbs.

- **Agent-callable cross-conversation search.** A `search_conversations(query)`
  tool so the model can pull context from past chats mid-turn ("what did we
  decide about X last week") without the user remembering which thread it lived
  in. The user-facing sidebar search already ships; this exposes the same recall
  to the model. Distinct from memory: memory is a curated, model-authored store
  of durable facts; this is full-fidelity search over raw message history.
  Scoped by `user_id` (the multi-user isolation invariant). Sketch: SQLite FTS5
  over `messages.content` for the keyword layer, optionally fused with embedding
  cosine where the endpoint advertises it — reuses `vector.ts` + the
  `[embeddings]` block + the RRF fusion + the nullable-`embedding`-column
  backfill pattern already built. Open questions: return whole messages or
  RAG-selected chunks; citation rendering (link back to source message + branch
  so a result restores the right leaf); indexing cost on a small box (gate the
  semantic layer behind the capability flag).

- **Code interpreter — phase-2.** The server-side Pyodide `run_python` built-in
  shipped (per-conversation worker, idle-reap + LRU evict + timeout, SSRF-gated
  net, media round-trip). Remaining:
  - _Streaming stdout._ The worker returns all stdout/stderr in one chunk at
    end of call, so a long cell feels frozen. `postMessage` per-line chunks → a
    new `tool_progress` SSE event → the in-flight tool block appends.
  - _Variable persistence across worker reaps._ Variables die with the worker.
    Snapshot `globals()` via dill-style pickling to
    `data/code-interpreter/{conversationId}.bin`, restore on next call. Bounded
    by size + age, config-gated.
  - _Workspace UI._ A per-conversation files page/drawer surfacing everything
    under `/workspace/` for browse/preview/download/delete. Today the user only
    sees files via the chip on the producing tool block.
  - _micropip wheel cache._ A per-conversation/per-user override path under
    `data/code-interpreter/wheels/` so operators can pin a wheel set without
    round-tripping the CDN on cold start.
  - _Pre-warm pool._ Config flag `prewarm_workers = N` to spin up idle workers
    at boot so the first call doesn't pay the 2–5 s cold start.
  - _Per-tool-call approval (optional)._ Some users may want to see code before
    it runs even though it's sandboxed — reuse the MCP approval infra with a
    per-user trust list.

- **Web search — quality.** `web_search` originally proxied SearxNG and returned
  only the raw top-N `{title, url, snippet}`, discarding everything else. Three
  improvements have shipped: it now surfaces SearxNG's **answers / infoboxes /
  corrections** (so simple queries resolve with no `fetch_url` round-trip),
  accepts optional **`time_range` / `categories` / `language`** args (freshness +
  scope), and **de-duplicates results** by a conservative normalized-URL key
  before trimming to `max_results`. (The RAG read path — hybrid select on long
  `fetch_url` pages — is separate and untouched by these.) Remaining:
  - _Snippet reranking of the result list._ Reorder results with the cross-encoder
    (now in hand via `[rerank]`) or BM25⊕embedding over `title + snippet`.
    Deferred deliberately: snippets are tiny and SearxNG already fuses engine
    rankings, so the marginal gain likely doesn't beat the added latency — the
    dedupe half (shipped) was the real win. Revisit only if result quality
    proves a problem in practice.

  (Search-and-read fusion — fan out searches, fetch, rank across sources — is
  the **deep research** item below, not duplicated here.)

- **Inline RAG with embeddings — phase-2.** Hybrid relevance selection on
  over-budget `fetch_url` pages shipped (structure-aware chunking + BM25 fused
  with embedding cosine via RRF), gated on the optional `[embeddings]` block,
  degrading to BM25-only when absent. Two of the deferred quality levers have
  since landed: a **cross-encoder reranker** (optional `[rerank]` block — reorders
  the top fused candidates before packing; degrades to the fused order on any
  failure) and **section breadcrumbs** (`fetch_url` returns `sections` +
  `outline` on the relevance path, turning single-shot lookup into multi-hop
  re-`find`). Framing (from an architecture review): the feature compensates for
  a fixed small context budget, so its value is _highest_ on the small-context
  local LLMs this project targets and _lowest_ on frontier cloud models; and it's
  tuned for **needle-finding, not whole-doc synthesis** (disjoint chunks +
  ellipses fragment a "summarize this page" read). Remaining, roughly by
  priority:
  - _Context-aware budget (the real lever)._ `MAX_CONTENT_CHARS` (and the
    relevance trigger) is one hard-coded value serving two regimes. Make it
    configurable — ideally per-endpoint/context — so a 200 K-context user rarely
    fragments while a local-8 K user gets aggressive selection. Caveat: per
    active model means giving the web tools the conversation's endpoint, which
    `ToolContext` doesn't carry today; a global config override is the cheap
    partial version.
  - _Apply to attached docs/URLs, not just `fetch_url`._ Embed-and-retrieve
    user-attached files / pasted notes and inject as system context.
  - _Smaller niceties._ Per-(url, model) embedding cache; tune batch sizing per
    backend; a follow-on to the reranker — a dedicated `rerank_model`-style LLM
    listwise path for operators without a cross-encoder endpoint (today `[rerank]`
    expects a `/rerank` cross-encoder).

- **Deep research.** A multi-step research mode: the model decomposes a question
  into sub-queries, fans out web searches, fetches and reads sources, and
  synthesizes a cited report — many tool-calls + turns for one prompt, rather
  than the single-shot `fetch_url` we have today. The pieces are mostly in hand
  (`web_search` + `fetch_url` with hybrid RAG, the SSRF + `web` gate, the
  agentic loop); what's missing is the _orchestration_: a planner that
  decomposes the query, a budget (max searches / fetches / wall-clock), and a
  synthesis pass producing a source-cited answer. Open questions: inline in the
  normal tool loop (simplest, but a long autonomous run wants progress UI —
  pairs with the code-interpreter `tool_progress` idea) vs. a distinct mode;
  citation rendering; whether the planner uses the main model or the task model.
  Effectively a prereq for fusion below.

- **Multi-model fusion (panel + judge).** Run one prompt through a _panel_ of
  models in parallel, then a judge model reads every response — consensus,
  contradictions, partial coverage, blind spots — and a final model writes the
  answer grounded in that analysis (cf. `openrouter/fusion`). Let the user
  define the panel + coordinating model, materialized like a custom-model
  preset; dispatch to the panel concurrently (we already hold multiple endpoints
  in the registry), feed responses to the judge, stream the synthesis. _Why
  deferred / gated:_ overkill and expensive (N+2 calls per prompt) for simple
  queries — the value shows up paired with **deep research** above (a panel of
  deep-researchers, judge synthesizes). Open questions: surfacing per-member
  cost/latency; whether panel members get web/tools or just the bare prompt;
  rendering the breakdown (collapsible per-model columns) vs. only the final
  answer; reusing the custom-model materialization path for the panel config.

- **Context compaction.** Summarize the conversation so far and continue from
  that summary as the new history. Mostly relevant for local LLMs pinned at
  8k–32k; cloud providers ship 100k–1M. The manual workaround already works
  ("ask for a summary, paste into a new chat"), so this is ergonomics, not a
  missing capability. Sketch: a "Compact conversation" header action that runs
  summarization through the conversation's _own_ main model (not the task model,
  which may lose fidelity); output branches off the active leaf with the summary
  as a new root user message, and the tree-shaped schema preserves
  pre-compaction history (switch back via sibling-nav). Open question:
  user-triggered only, or auto-fire when a per-model context estimate crosses a
  threshold.

- **Canvas / collaborative document mode.** A long-lived document the model
  edits across turns and the user can edit too — a side-by-side artifact pane
  rather than inline chat messages — for work that needs several revisions
  (prose, a spec, a config) where re-pasting the whole document every turn is
  the friction. The canvas is a _mutable artifact_, not an append-only message,
  so it wants its own entity + version chain. Sketch: an `artifacts` table
  (per-user, `conversation_id`-scoped) holding current content + version
  history; the model edits via a diff/replace tool (`update_canvas`) so turns
  apply targeted edits; human edits append versions to the same chain.
  Markdown-first (reuse the server-side markdown-it + shiki pipeline). Open
  questions: reconcile with the tree schema — does a canvas version pin to the
  leaf that produced it, so branch-nav restores the matching doc state?;
  concurrent human + model edit conflicts; whether to diff-render edits.

- **Text-to-speech (read a reply aloud).** A per-message "read aloud" action on
  a text reply (plus an optional auto-read toggle). _Why this ranks above its
  input sibling (**Voice input**, deferred to long-term):_ most devices already
  ship reasonable voice typing (iOS keyboard dictation, etc.), so input is a
  solved problem users carry with them — whereas good _expressive_ speech output
  is still scarce. Pairs with the creative-writing use case, where a flat read
  undersells the text.

  _Like image/video, TTS is a separate modality that rides its own upstream, not
  the chat endpoint_ — so the chat LLM lacking `/v1/audio/speech` (e.g. llama.cpp)
  is a non-issue; you'd no more route TTS through the text model than image gen.
  It becomes its own registry entry (global or per-user), decoupled from which
  model wrote the text.

  _The decisive axis is expressiveness, not naturalness — and it collapses the
  tiers to two._ Split "quality" in two: **naturalness** (clean human diction)
  vs. **expressiveness** (acting — sadness, tension, sarcasm, nonverbals). On
  naturalness, modern OS voices (Apple neural, Google WaveNet, Windows online) are
  already a tie with small local models — so a lightweight in-process model
  (Kokoro/Piper) is **dominated by the free OS voices and dropped**: it's flat
  _and_ no better-sounding. The whole feature only earns its infra on the
  expressiveness axis, where OS voices have a hard ceiling (competent newsreader,
  emotionally flat) and the expressive open models genuinely act. So:
  - _Floor — OS voices via the browser Web Speech API._ Free, zero infra, ships
    day one, fine for utility reading. Caveat: not always on-device — Chrome's good
    voices are Google cloud, Windows' are Microsoft online (only Apple's are local),
    so the "free" floor can ship reply text to a third party — itself an argument
    for the self-hosted tier on privacy grounds, independent of quality.
  - _Primary bet — a self-hosted expressive endpoint_ (**Orpheus**, **Dia**, or
    **Chatterbox**). The only self-hosted tier that beats the OS floor, and it
    keeps synthesis local. **Orpheus** is a natural fit for an existing llama.cpp
    deployment: its Llama-3B backbone can run on llama.cpp itself (plus a small
    SNAC decoder sidecar), reusing the inference stack already in place. Cost: real
    VRAM contention with a co-located image/video model, and expressive models
    trade some stability (artifacts, slower-than-realtime) for emotion — hence
    opt-in, not default.
  - _Optional max-expressive cloud_ (**Hume Octave** — LLM-based, emotion-first;
    **ElevenLabs v3** — audio-tag control) for those who'll pay and lack GPU
    headroom. Against the self-hosted ethos, but already a supported endpoint kind.

  _Inferred vs. tag-driven emotion — the constraint that picks the model._ We feed
  the model raw LLM prose: emotional _content_ but no _markup_. Models that infer
  emotion from text semantics (Hume Octave, ElevenLabs v3, and the autoregressive
  open ones — Orpheus, Dia) "just work" on it; tag/instruction-driven ones
  (OpenAI gpt-4o-mini-tts's `instructions` field, Chatterbox's exaggeration knob,
  reference-audio models like XTTS/F5) read flat unless fed a signal. That signal
  is the fork: pick an inference-native model and skip it, or add an "emotion
  director" pre-pass (the chat model annotates its own output with tags / an
  instruction string) — broader model support at the cost of a call + latency +
  mis-tag risk, but it gains author-steerable emotion vs. letting the model decide.

  A narrated-storyboard / audiobook step also pairs with the **multimodal
  pipeline** bet. Open questions: standardize strictly on the `/v1/audio/speech`
  contract (simplest, but excludes Hume/ElevenLabs/Cartesia, which have their own
  wire formats) vs. a thin TTS-provider adapter like `MediaStore`; stream audio
  sentence-chunked as it generates (pairs with the streaming-text path) vs.
  synthesize-then-play; cache rendered audio on the message row the way
  `content_html` is (re-listen for free) vs. regenerate; voice/persona selection,
  including a per-custom-model default voice (a "storyteller" preset reads in a
  fitting voice); and how the markdown→speech reduction strips code blocks /
  tables / links before synthesis.

- **Multi-user — nice-to-haves.** Role + invite flow, admin UI, and data
  isolation shipped. Remaining: a per-user storage-quota / usage view; bulk user
  import.

- **Virtualized message list.** Long conversations eventually overwhelm the DOM.
  `@tanstack/svelte-virtual` is the candidate; the hard part is the streaming
  case — the bottom message's height grows mid-stream, so the virtualizer
  re-measures every chunk and the pin-to-bottom anchor tracks virtualized
  content height. Likely pattern: virtualize only historical messages, leave the
  streaming message in plain DOM until it completes. Trigger — implement when
  real conversations actually feel janky; below that threshold the measurement
  overhead can exceed just rendering everything.

- **DB-backed endpoint management UI** (instead of `config.toml` only). Add
  endpoints from a settings page; reload the registry without restart.

- **S3-compatible media storage.** `MediaStore` is already the abstraction;
  implement `S3MediaStore` (Backblaze B2, Cloudflare R2, MinIO).

- **Postgres deployment option.** Drizzle is dialect-portable; needs a
  postgres-driver adapter and migration regeneration.

- **Bridge-side SSE normalization** (off by default via header). Saves
  duplicate normalizers if other clients ever consume the bridge.

- **Persistent agentic workspace (Open Terminal or equivalent).** A self-hosted
  shell + filesystem for long-running, multi-turn code tasks — clone a repo,
  modify files across turns, run tests, open a PR. Distinct from the code
  interpreter (the scratchpad-compute path); this is repo-style work needing
  state on a real disk with real tools. Listed late because the code interpreter
  covers many cases. Open Terminal (open-webui/open-terminal) is the
  most-developed candidate, but integration is more than "plug in as MCP": its
  MCP wrapper is a separate subcommand absent from the default Docker image; its
  richest capabilities (file sidebar, PTY, port preview, upload) are REST-shaped
  and hidden from `/openapi.json`; and per-conversation isolation isn't built
  in. Two paths, by effort:
  - _OpenAPI → MCP translation in the registry._ Add an `openapi://...`
    transport that fetches a spec and registers each operation as a tool.
    Sidesteps the wrapper's packaging gaps and is generally useful (any
    OpenAPI-shaped sandbox works). Prereq for the lighter path.
  - _First-class "Open Terminal connection."_ Reimplements Open WebUI's
    connection mode (REST file sidebar, PTY tab, port preview). Much more work;
    only worth it if persistent workspaces become load-bearing.

  GlyphStream-side UX either way: terminal/command outputs deserve their own
  bubble (monospace, collapsible, optional re-run) rather than the generic
  tool-call block; a per-conversation file explorer; and scope/quotas separate
  from per-call approval (directory allowlist + writable-area boundary
  persisting across a turn's tool chain).

- **Unpin `drizzle-orm` / `drizzle-kit` off the 1.0 RC once 1.0 GA ships.**
  Both are pinned exact to `1.0.0-rc.3` because node:sqlite support only exists
  on the v1 line and an RC can ship breaking changes between pre-releases. When
  GA lands, move both to a `^1` range, re-run the suite + a toolchain-free docker
  boot, and revisit the better-sqlite3 inert-peer note in CLAUDE.md (the
  optional-peer situation may change at GA).

## Differentiation bets (exploratory)

Most of the v2 list above is _the good version of a thing other chat UIs also
have_. This section is the opposite: capabilities that lean on what a
**self-hosted, always-on, multimodal, multi-person, permanently-accumulating,
un-metered** box can do that a stateless cloud chat structurally can't. Less
proven, deliberately speculative — captured so the framing isn't lost. Each
names the asset it pulls on. Priority within the section is unranked; the
proactivity and pipeline bets are the most identity-defining.

- **Standing agents / "the morning brief"** (asset: always-on process).
  Scheduled prompts that run _without the user present_ and produce a feed —
  "every morning, deep-research these three topics and push me a digest", "summarize
  what changed in my watched repos overnight". This is the most differentiated
  bet in the file: it reframes the product from a request-response chat box into
  an _ambient assistant that works while you sleep_, and it's only possible
  because the architecture is a persistent Node process + SQLite + push
  notifications (all shipped — see `docs/notifications.md`), not a serverless
  function. Composes directly with **deep research** above (the digest _is_ a
  scheduled deep-research run) and the code-interpreter `tool_progress` idea (a
  long autonomous run wants progress UI). Sketch: a `scheduled_agents` table
  (per-user, `user_id`-scoped — the isolation invariant) holding a prompt +
  cron-ish cadence + target model + enabled tools; a background runner on the
  media-purger pattern (single process, hardcoded tick that wakes due agents);
  each run lands as a normal conversation (so history/branching/gallery all work
  for free) and fires the existing push payload (which already carries
  `modality`). Open questions: do runs accrete into one long thread or spawn a
  fresh conversation each fire?; per-user run quotas / wall-clock budget so a
  household can't peg the GPU; whether the scheduler is its own thing or the
  generic primitive that **watchers** (below) also rides on; surfacing/editing
  schedules (a `/settings/agents` page vs. a "make this recurring" action on an
  existing chat).
  - _Watchers / triggers._ The condition→notify sibling of the schedule→digest
    agent: "ping me when this product drops below $X", "when this repo cuts a
    release". Same background-runner + notification infra; the delta is a
    persisted _last-seen state_ per watcher and a comparison each tick. Likely
    the same `scheduled_agents` table with a `trigger` mode. Open question:
    polling cadence vs. politeness to the watched source (and SSRF reuse —
    watchers fetch arbitrary URLs, so they ride the same egress gate as the web
    tools).

- **Multimodal pipeline mode (storyboard / picture-book / comic)** (asset:
  text + image + video in one process). One prompt → the model writes a script →
  generates a panel image per beat → optionally animates each panel to video →
  assembles the result. A _pipeline product_ no single-modality chat can ship,
  and the most visible payoff of GlyphStream's most unusual asset (all three
  modalities + a permanent gallery to hold the output, under one process).
  Strong household fit: kids' stories, D&D session recaps, recipe cards, how-to
  sequences. Sketch: this is an orchestration over capabilities already present
  (chat for the script, `/v1/images` + `/v1/videos` upstreams, the fan-out
  queue, the media gallery + stacks) — what's missing is the _planner_ that
  decomposes a brief into beats and the _assembly_ step. Lands well as a
  materialized preset like a custom model (a saved "comic" pipeline = layout +
  panel count + image/video model choices). Open questions: render the pipeline
  as one rich artifact (pairs with the **canvas** item) or as a stacked gallery
  card?; how much user steering between stages (approve the script before
  spending image generations) vs. one-shot; assembly target (a contact-sheet
  image, an MP4, a flippable reader view).
  - _Character / asset consistency._ The missing primitive that makes the
    pipeline actually good: save a "character" (reference image + description)
    and reuse it across generations so the same hero/dog/product appears in panel
    1 and panel 7. Independently useful outside pipelines (any image-to-image
    series). Sketch: a per-user `assets` table referencing a gallery media row +
    a text descriptor; injected into prompts and/or attached as a reference image
    where the upstream supports it. Open question: how much consistency is even
    achievable is upstream-model-dependent — degrade gracefully where the
    endpoint has no reference-image / IP-adapter support.

- **Gallery search & large-library navigation** (asset: permanently-accumulating
  multimodal corpus). Stacking (shipped) bought _display_ density; it didn't
  help _findability_ as the gallery grows from a scroll into a library. The
  missing capability is finding a specific asset fast — leaning on a key
  property: for a _generated_ image the prompt is already a dense description of
  its content (the `media` row stores `promptFull` + `promptExcerpt`), so
  searching the prompt covers most of what pixel-level "visual search" promises,
  with little or no new infra. Phased cheapest-first:
  - _Prompt search — keyword, then semantic (the lead win)._ Start with SQLite
    FTS5 over `promptFull` (optionally the conversation title + `sourceModel`):
    no new infra, instant, fully offline, and it resolves "the red sunset ones"
    whenever that phrasing was in the prompt — which for generated media it
    nearly always was. Then add a semantic leg that **reuses the existing text
    `[embeddings]` endpoint** — embed each _prompt_ (text, not pixels), so it
    rides the whole `memories` pattern verbatim (`embedding` blob + `embeddingModel`
    columns, the partial `WHERE embedding IS NULL` index, the backfill sweep in
    `embedding-backfill.ts`, `vector.ts` cosine, RRF fusion). Crucially needs
    **no new endpoint**, unlike CLIP below. Open questions: which fields join
    the FTS index; degradation for _uploaded_ images, which have no prompt
    (fall back to filename, or just exclude them from prompt search).

  - _Faceted filters + date grouping._ The columns already exist (`sourceModel`,
    `sourceEndpointId`, `kind`, `createdAt`) — filter the gallery by model /
    endpoint / kind / date range with pure query work. The gallery is already
    reverse-chronological with stacking, so a "timeline" isn't a re-sort: it's
    **group headings** (Today / This week / by month) over the existing order
    plus a **quick-jump** rail to those groupers. Open question: how a heading
    reconciles with a stack that straddles a date boundary (date the stack by
    its newest member, most likely).

  - _Lineage view._ `sourceMediaId` already chains i2i / i2v derivations (this
    image was edited / animated _from_ that one). Rather than a separate view,
    likely a **logic extension of stacking**: stacks today group media from the
    same conversation; lineage stacking would group a derivation chain. The
    integration is the real work — an image can belong to _both_ a conversation
    stack and a derivation chain, and lineage can cross conversations (regenerate
    in a new chat from a gallery image) where conversation-stacking can't. Open
    questions: do the two grouping axes nest or does one take precedence?; how to
    render a multi-step chain inside the existing expand-a-stack affordance.

  - _Original visual search (CLIP) — low priority._ The pixel-level version:
    true text→image ("find more like this", content the prompt never mentioned)
    needs a **shared text+image embedding space** (CLIP-style) — a _new
    multimodal endpoint_ plus embedding every image once, stored as a blob on
    the media row. Deferred to last precisely because prompt search above
    already covers most of the need with existing infra; CLIP only adds value
    for uploaded images, un-prompted content, and pure visual similarity. Gate
    behind a capability flag the way text embeddings already degrade off; open
    question of where the image-embedding model lives (another endpoint vs. a
    bundled local model — the latter fights the lightweight constraint).

  - _Style / prompt library._ Mine the user's own generation history for
    recurring prompt patterns and surface them as reusable, auto-discovered
    presets ("your styles") — distinct from hand-saved custom-model presets, and
    from prompt _search_ (this clusters for reuse rather than retrieves). Cheap;
    mostly a query + clustering over the prompt history the FTS work already
    indexes. Open question: auto-cluster vs. just a "reuse this prompt"
    affordance on a gallery item, which captures most of the value for far less.

- **Multi-human + AI conversations** (asset: a real household of people).
  A thread where two or more _people_ and the model all participate — group chat
  with an AI member — vs. today's strictly single-user-per-conversation model.
  Almost no one does this well, and the pieces are unusually close: real
  multi-user identity ships, and the tree schema already carries `user_id` per
  row, so "who authored this node" has a natural home. The hard part is _not_
  the data model but the invariants: the multi-user isolation rule ("every query
  scopes by `user_id`") is load-bearing for privacy, and a shared conversation
  is a deliberate, scoped hole in it — needs an explicit membership table
  (`conversation_members`) and every read/write re-checked against membership
  rather than sole ownership. Open questions: real-time presence / typing (a
  WebSocket layer the app doesn't have yet) vs. async turn-taking (cheaper,
  fits the existing request model); how branching reconciles with multiple human
  authors; per-message authorship attribution in the UI.
  - _Shared household knowledge base._ A _shared_ (opt-in) memory the AI
    maintains and answers from — recipes, the wifi password, the vet's number —
    distinct from per-user memory, which is private by the isolation invariant.
    Reuses the memory save/update/forget primitives + embedding recall, but
    keyed to a household/group scope rather than `user_id`. Gated on the
    multi-human work above (it needs a notion of "group" to scope to). Open
    question: governance — who can write/delete shared facts, and how a private
    memory gets promoted to shared.

## Long-term / nice-to-have

- **2FA (TOTP) on GitHub OAuth.** Passkey login already shipped as a peer
  primary method (the `userVerification: required` ceremony is itself
  multi-factor), so this is only an authenticator-app TOTP layer on the GitHub
  side. Low priority — with a numeric-ID allowlist the GitHub-side attack
  surface is already narrow.

- **Voice input** via local Whisper (or the upstream `audio.transcriptions`
  endpoint once the bridge supports it).

- **Conversation export** (JSON / Markdown). Useful as an exit ramp, but the
  priority is building features that make users not want to leave.

- **Notification follow-ups — polish.** Web Push, in-app toast, native iOS Web
  Push all shipped (see `docs/notifications.md`). Remaining: optional completion
  sound with volume control; per-modality config ("only sound for video" — the
  payload already carries `modality`, the SW just needs a routing pass); a "your
  devices" UI surfacing `push_subscriptions.user_agent` with per-device revoke.

- **High-contrast / accessibility theme.** The themes system (semantic tokens,
  light+dark) shipped; a high-contrast scheme is the most practical additional
  theme beyond aesthetics. Deferred until the need arises.

- **Stored media dimensions (kill layout shift).** Image/video parts carry only
  `{ mediaId, alt }` — no intrinsic size — so the browser can't reserve space
  and media pops the layout when it loads (CLS on first render and in the
  lightbox, plus a jump-to-top when switching to a tall image branch, currently
  patched with a re-center-on-image-load in `selectSibling`). Capture
  width/height at generation / upload time, store on the media row, thread it
  into the image part, set `aspect-ratio` on the `<img>`. Retires the re-center
  workaround.

- **Gallery favorite / pin tier.** A second-level distinction beyond "in the
  gallery vs. hard-deleted" — a favorite flag protecting media from any future
  bulk-cleanup sweep. A single boolean column + a lightbox star. The rationale
  only materializes once an automated bulk-cleanup affordance exists to protect
  favorites _from_.

- **Preference: default to deleting media when deleting conversations.** A
  single boolean on `UserPreferences`, read in the layout's `deleteConversation`
  flow to seed the modal's `deleteMediaToo` default. Saves power users a click —
  trivial to ship if demand shows up.

- **Optional cap on accumulated fan-out variations.** Media regenerate is
  additive (a re-roll adds a sibling rather than replacing — see the keep-many
  compare grid), so repeated Regenerate-and-keep grows DB rows + stored media
  unbounded; the per-conversation cap only bounds _concurrent_ branches, and the
  purger only sweeps zero-ref media. This is deliberate (consistent with the
  app's accumulate-then-prune model). If unbounded growth ever bites a small
  box, the fix is a total-sibling-per-fan-out cap or a bulk-cleanup sweep —
  neither worth the friction pre-emptively.

- **Near-duplicate detection (perceptual hash).** A cheap (no-AI, no-endpoint)
  pHash per image to cluster near-identical media and surface a "collapse / bulk
  clean" affordance — pairs with the favorite/pin tier (protect favorites from
  the sweep) and the fan-out cap above. _Low priority, and likely low yield:_
  generation is stochastic, so even the same prompt on the same model produces a
  _different_ image each run unless the seed is pinned. The multi-model grid's
  duplication is intentional (different models, kept for comparison), not the
  redundant kind. So _true_ duplicates are uncommon — they need a deliberately
  fixed seed or an unlucky collision — which is exactly why this stays a
  nice-to-have rather than a findability/storage lever. Build only if a real
  library shows duplicate clutter in practice.

- **Background sync / offline composition.** Service worker queues messages
  while offline, resends on reconnect. Low priority — chat apps generally don't
  need this.
