# GlyphStream

**A lightweight, self-hosted web chat frontend for any OpenAI-compatible backend.**

GlyphStream sits in front of N upstream endpoints — llama-server, vLLM, Groq,
OpenAI, [openai-api-bridge][bridge] for ComfyUI / Venice / OpenRouter /
ImageRouter, anything that speaks `/v1/chat/completions` — and aggregates
them into a single fast chat UI with one model picker.

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/images/hero-dark.jpg">
    <img src="docs/images/hero-light.jpg" alt="GlyphStream chat view" width="820">
  </picture>
</p>

## Why GlyphStream

- **Genuinely lightweight.** One Node process + SQLite. ~200 KB gzip client
  bundle. Markdown renders server-side (shiki highlighting included) and is
  cached per message — the client stays lean.
- **Spec-first, not vendor-first.** Developed against the OpenAI API spec, so
  any compatible upstream works. Per-vendor streaming quirks (DeepSeek-R1
  reasoning, o-series, OpenRouter) are small opt-in normalizers, not forks.
- **Safe to put on the public internet.** OAuth (GitHub, Google, OIDC) +
  passkey (WebAuthn) login, a first-run setup wizard, and invite-only
  multi-user accounts (admin
  role + per-user data isolation); CSP, SSRF-guarded tool egress, same-origin
  enforcement on mutating APIs.
- **Multi-model is a first-class workflow.** Fan a prompt out to several
  models side by side — text, image, or video — and compare in one grid.
- **Easy exit from Open WebUI.** A one-command importer migrates your full
  OWUI chat history, tree-shaped branches included.

## Features

### Chat

- Streaming responses with **live markdown rendering** and syntax-highlighted
  code, swapped post-stream for the server's full-coverage highlight.
- **Collapsible reasoning blocks** for thinking models (DeepSeek-R1, o-series).
- **Branching conversations** — edit or retry any message and navigate
  siblings with ‹ N/M › arrows; the schema is a tree, not a log.
- **Full-text search** across every conversation.
- **Auto-titling** via a small, fast task model of your choice.
- Token usage and generation speed (tok/s) per message; Stop button wired
  across chat, image, and video generations. A bar above the composer shows the
  thread's running context size against the model's window (`27,725 / 40,960
tokens`) when the size is known — auto-detected from llama.cpp / vLLM, or
  set per endpoint ([configuration](docs/configuration.md#context-window-context_window)).
- **Context compaction** — when a thread fills a small window, summarize the
  older turns through the conversation's own model and keep going. The real
  messages stay in the thread (the summary is a collapsed divider); only what's
  sent to the model is trimmed. Compact by hand from the bar above the composer,
  or opt into automatic just-in-time compaction in Preferences. A compaction is
  reversible — undo it from the toast or the summary divider until you send the
  next message.
- In-flight generations **survive disconnects and iOS PWA suspends** — leave
  and come back; the stream recovers.
- **Draft autosave** — a half-typed prompt is kept per-conversation in local
  storage and restored after a reload, so an interrupted message (e.g. an iOS
  PWA frozen in the background) isn't lost.

### Multi-model

<p align="center">
  <img src="docs/images/fanout.jpg" alt="Multi-model fan-out comparison grid" width="820">
</p>

- Every endpoint's models in **one searchable picker**, grouped by provider,
  with favorites (drag-to-reorder, pinned in the sidebar) and per-turn
  switching mid-conversation.
- **Fan-out compare**: select several models and send one prompt to all of
  them — text, image, or video — streaming side by side with per-branch
  queue states and timers. Keep the winner or keep them all.
- **Split attachments**: fan N input images across M models for a full
  cross-product comparison grid.
- **Saved model sets**: name a compare cart you reach for often (your go-to
  image models, say) and re-apply it to a new prompt in one click.
- Per-endpoint concurrency caps queue requests instead of OOMing your
  single-GPU box ([configuration](docs/configuration.md#limiting-concurrency-max_concurrent)).

### Images & video

<p align="center">
  <img src="docs/images/gallery.jpg" alt="Media gallery" width="820">
</p>

- Inline **image and video generation** through `/v1/images` / `/v1/videos`
  upstreams, with job-status progress for long video renders.
- **Image-to-image follow-ups** auto-attach the last generated image;
  re-rolls are additive, never destructive.
- **Prompt enhancement** (optional) — before generating, an LLM rewrites your
  prompt into the format the target model prefers: for images (natural-language
  narrative, booru tags, keyword soup, hybrid, or structured JSON) and for video
  (cinematic prose or structured shot description, adding camera motion and
  pacing). Per-model, fans out per-branch in a multi-model compare, and the
  original prompt is kept and shown alongside the
  result ([configuration](docs/configuration.md#prompt-enhancement-image_enhancement)).
- A **gallery** of everything ever generated: lightbox, bulk operations,
  jump back to the source conversation, or launch a new one from any image.
  Related media (a whole conversation, or a multi-model batch sharing one
  prompt) **stack** into a single card you can expand — toggle it off for the
  flat view. **Search your prompts** to find any generation (keyword, plus
  semantic synonym matching when an embedding model is configured), **filter by
  the model** that made it, and browse by time with **sticky date headers** (day
  or month) plus a right-edge **timeline rail** to jump to any month.
- **Permanent media storage** — assets are pulled from the upstream on
  generation, ref-counted, and purged only after a grace period with zero
  references.
- Attach images and files to messages (drag-drop, paste); images are resized
  client-side before upload.

### Tools & agents

- **Native OpenAI tool calling** with a multi-step loop — the model chains
  tools until it's done ([guide](docs/tools.md)).
- **Web search** via self-hosted SearxNG — instant-answer/infobox blocks,
  freshness & category filters, de-duplicated results — and **`fetch_url`**
  page reading with Mozilla Readability extraction plus hybrid BM25 + embeddings
  retrieval for long pages, optionally sharpened by a cross-encoder **reranker**
  ([guide](docs/web-search.md)).
- **Python code interpreter** — a sandboxed Pyodide runtime with numpy /
  pandas / matplotlib, persistent per-conversation state, and file round-trip
  to chat attachments ([guide](docs/code-interpreter.md)).
- **MCP servers** — point `config.toml` at any Model Context Protocol server
  (stdio or HTTP) and its tools join the registry, gated by per-tool
  Allow / Allow Always approval; authenticate with a shared token or each
  user's own credential. High-tool-count servers can set `defer_tools` to hide
  behind a `search_tools` lookup (hybrid keyword + embeddings) so they don't
  spend context every request ([guide](docs/mcp.md)).
- **Agent skills** ([agentskills.io](https://agentskills.io) spec) — import
  skill bundles, activate them by model judgment or an explicit `/skill-name`
  slash command.
- **Per-user memory** the model can save, update, and forget across sessions —
  once the store grows large the most relevant facts (recently or often recalled,
  or freshly saved) stay inlined in full while the rest collapse to a compact
  topic index, and the model reads those bodies back on demand by id or search
  (semantic search is added when an embedding model is configured). With an
  optional `[memory_model]` configured, a scheduled background "dreaming" pass
  periodically tidies the store — merging duplicates, folding superseded facts,
  and distilling stale notes — with soft-delete reversibility, so anything it
  changes stays reviewable and restorable from settings for ~30 days.
- **Conversation recall** — a `search_conversations` tool lets the model search
  your past chats (full message history, owner-scoped, with an optional recency
  filter) when you refer back to something discussed before, instead of guessing.
  Gated by the same Personalization toggle as memory ([guide](docs/tools.md)).
- **Per-conversation privacy toggles** — switch off web access, code
  execution, personalization, or any MCP server for a single conversation.
- **Private chat** — an incognito mode (toggle on the new-chat screen) that
  airgaps a conversation: its content never feeds your memories, summaries, topic
  overview, or `search_conversations`, and personalization / web / MCP tools are
  sealed off for the chat. Code execution and skills stay on. The whole app
  re-tints so you can't miss that you're in it ([guide](docs/tools.md)).

### Self-hosting & polish

- **OAuth (GitHub, Google, generic OIDC) + passkeys**, together or alone;
  first-run setup wizard; one-flag account revocation
  ([guide](docs/authentication.md)).
- **Invite-only multi-user** — the setup-wizard account is the admin; everyone
  else joins via an admin-issued `/join` link (any OAuth provider or passkey). Per-user
  data isolation, plus an admin panel to invite, disable, or remove accounts
  ([guide](docs/multi-user.md)).
- **Installable PWA** with iOS-aware safe areas and **push notifications**
  when long generations finish ([guide](docs/notifications.md)).
- **Start a chat from a URL** — open the home page with a `#q=` fragment
  (e.g. `https://your-host/#q=write%20a%20haiku`) to prefill the composer.
  Handy for an iOS share-sheet Shortcut, since iOS won't let a PWA receive
  shares directly; the fragment keeps even long prompts off the request line.
- **Themes**: the Signature frosted-glass look, plus Claude and ChatGPT
  themes; light / dark / system, with per-theme motion personalities.
- Personalization: structured persona fields (name, about you, custom
  instructions) and rotating greetings.
- **Custom models** — saved presets of base model + system prompt + params,
  like custom GPTs, with per-preset feature-toggle defaults.
- **Docker deployment** in a ~200 MB image, automatic migrations, any
  reverse proxy in front ([guide](docs/deployment.md)).
- **Open WebUI import** ([guide](docs/import-owui.md)).

## Quick start

### Docker (recommended)

```bash
mkdir -p /srv/glyphstream/{data,imports}
cd /srv/glyphstream
cp /path/to/repo/.env.example .env                 # set AUTH_SECRET etc.
cp /path/to/repo/config.toml.example config.toml   # define ≥1 upstream
cp /path/to/repo/docker-compose.yml .
docker compose up -d --build
curl http://localhost:3000/api/health
```

Visit the app, and the first-run wizard at `/setup` creates your operator
account (any OAuth provider or passkey). Put a reverse proxy in front for TLS — see the
[deployment guide](docs/deployment.md).

### Local development

```bash
pnpm install
cp .env.example .env                   # fill in AUTH_SECRET
cp config.toml.example config.toml     # define at least one upstream
pnpm dev                               # http://localhost:5173
```

## Documentation

| Guide                                            | Covers                                                                                           |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [Configuration](docs/configuration.md)           | `config.toml` + `.env`, endpoints, secrets convention, concurrency, auto-titling                 |
| [Authentication](docs/authentication.md)         | OAuth (GitHub, Google, OIDC) setup, passkeys, the setup wizard, `EXTERNAL_BASE_URL`              |
| [Multi-user & admin](docs/multi-user.md)         | Roles, issuing invites, the `/join` flow, enabling / disabling / removing accounts               |
| [Tool calling](docs/tools.md)                    | Enabling tools per endpoint, model requirements, llama.cpp setup, feature toggles, writing tools |
| [Web search & RAG](docs/web-search.md)           | SearxNG setup, `fetch_url`, the `[embeddings]` and `[rerank]` blocks                             |
| [Code interpreter](docs/code-interpreter.md)     | The Pyodide sandbox, file round-trip, resource limits                                            |
| [MCP servers](docs/mcp.md)                       | stdio/HTTP transports, the approval model, examples                                              |
| [Push notifications](docs/notifications.md)      | VAPID keys, multi-device behavior, iOS install requirement                                       |
| [Deployment](docs/deployment.md)                 | Docker, reverse proxies (Caddy, nginx, Synology, Cloudflare), compression                        |
| [Importing from Open WebUI](docs/import-owui.md) | The one-shot migration script and its caveats                                                    |

## Need image / video generation?

[openai-api-bridge][bridge] is a companion project that aggregates
image/video/chat backends behind one OpenAI-compatible HTTP API: ComfyUI
workflows, Venice and ImageRouter image/video generation, OpenRouter
(including its chat-completions-shaped image generation), and any
OpenAI-compatible upstream as passthrough. Point GlyphStream at it and all
of those models show up in the picker alongside your chat backends.

## Stack

SvelteKit (adapter-node) · TypeScript · Tailwind v4 · Drizzle ORM (SQLite) ·
arctic + @simplewebauthn · bits-ui · Vitest + Playwright · pnpm.

## License

MIT — see `LICENSE`.

[bridge]: https://github.com/xiphux/openai-api-bridge
