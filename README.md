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

- **Genuinely lightweight.** One Node process and a SQLite file. A ~200 KB gzip
  client; markdown and code highlighting render on the server and are cached.
- **Any OpenAI-compatible backend.** Built against the spec, not a vendor —
  local or cloud, chat, image or video, all in one picker.
- **Compare models side by side.** Send one prompt to several models — text,
  image or video — and keep the winner.
- **Images and video are first-class.** Generation, image-to-image, aspect
  ratios, prompt enhancement, and a searchable gallery of everything you've made.
- **Tools that do real work.** Web search, page reading, a Python sandbox, MCP
  servers, agent skills — and a memory of you that it keeps tidy on its own.
- **Safe on the public internet.** OAuth and passkeys, invite-only accounts with
  per-user isolation, and an app lock for the installed app.

## Features

### Chat

- Streaming markdown, collapsible reasoning, and **branching** — edit or retry
  anything and flip between versions.
- A **context bar** with an itemised breakdown of what's filling the window, and
  reversible **compaction** when it fills.
- **Canvas** for documents revised over several turns, **prompt snippets**, full-text
  search, archive, and auto-titling.
- Generations **survive disconnects** and iOS app suspends; drafts autosave.
- Themes (including a frosted-glass Signature look), personalization, and an
  installable PWA with **push notifications**.

[More on chatting →](docs/chat.md)

### Multi-model

<p align="center">
  <img src="docs/images/fanout.jpg" alt="Multi-model fan-out comparison grid" width="820">
</p>

- Every endpoint's models in **one searchable picker**, with favorites and
  per-turn switching.
- **Fan-out compare** across text, image and video models; **split attachments**
  for a cross-product grid; **saved model sets** for the comparisons you repeat.
- **Custom models** — presets of base model + system prompt + params, like
  custom GPTs.
- Concurrency caps and **shared-GPU queues** that hand VRAM over between chat and
  image models, so a single-GPU box queues instead of running out of memory.

[More on models →](docs/models.md)

### Images & video

<p align="center">
  <img src="docs/images/image-chat.jpg" alt="Image conversation with the aspect-ratio picker open" width="820">
</p>

- Inline image and video generation, **image-to-image** follow-ups, and an
  **aspect-ratio picker** that also follows a shape named in your prompt.
- Optional **prompt enhancement** rewrites your prompt into the format each
  target model prefers.
- A **gallery** with prompt search, stacks, favorites, a timeline, and a 30-day
  Recently deleted.
- **Conversation avatars** — the model describes itself, an image model draws it.

<p align="center">
  <img src="docs/images/gallery.jpg" alt="Media gallery" width="820">
</p>

[More on images & video →](docs/media.md)

### Tools & memory

- **Native tool calling** with a multi-step loop ([guide](docs/tools.md)).
- **Web search** via SearxNG and **page reading** with hybrid retrieval
  ([guide](docs/web-search.md)).
- A sandboxed **Python interpreter** with numpy / pandas / matplotlib
  ([guide](docs/code-interpreter.md)).
- **MCP servers** (stdio or HTTP) with per-tool approval and per-user
  credentials ([guide](docs/mcp.md)), and **agent skills**
  ([agentskills.io](https://agentskills.io)).
- **Memory** across conversations, tidied in the background, plus **recall** of
  past chats — and a **private chat** mode that keeps a conversation out of both
  ([more](docs/chat.md#memory-and-recall)).
- Every tool can be switched off per conversation.

### Self-hosting

- OAuth (GitHub, Google, generic OIDC) and passkeys; a token-gated first-run
  wizard; per-device session management ([guide](docs/authentication.md)).
- **Invite-only multi-user** with an admin panel and an endpoint health view
  that shows what each backend is generating and queueing
  ([guide](docs/multi-user.md)).
- A ~260 MB Docker image with automatic migrations
  ([guide](docs/deployment.md)), and a one-command **Open WebUI importer** that
  brings your history across, branches included ([guide](docs/import-owui.md)).

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

Open the app once to mint the one-time setup URL, then grab it from the log
(`docker compose logs | grep '\[setup\]'`) — the first-run wizard requires a
token, so an instance that's reachable before you finish can't be claimed by
someone else. Opening that URL creates your operator account (any OAuth
provider or passkey). Put a reverse
proxy in front for TLS — see the [deployment guide](docs/deployment.md).

### Local development

```bash
pnpm install
cp .env.example .env                   # fill in AUTH_SECRET
cp config.toml.example config.toml     # define at least one upstream
pnpm dev                               # http://localhost:5173
```

## Documentation

| Guide                                            | Covers                                                                                              |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| [Chatting](docs/chat.md)                         | Branching, the context bar and compaction, memory and recall, themes, `#q=` links                   |
| [Models](docs/models.md)                         | The picker, fan-out compare, model sets, custom models, sharing a GPU                               |
| [Images & video](docs/media.md)                  | Generation, aspect ratios, prompt enhancement, the gallery, avatars                                 |
| [Configuration](docs/configuration.md)           | `config.toml` + `.env`, endpoints, secrets convention, concurrency, auto-titling                    |
| [Authentication](docs/authentication.md)         | OAuth (GitHub, Google, OIDC) setup, passkeys, the setup wizard, `EXTERNAL_BASE_URL`                 |
| [Multi-user & admin](docs/multi-user.md)         | Roles, issuing invites, the `/join` flow, enabling / disabling / removing accounts, endpoint health |
| [Tool calling](docs/tools.md)                    | Enabling tools per endpoint, model requirements, llama.cpp setup, feature toggles, writing tools    |
| [Web search & RAG](docs/web-search.md)           | SearxNG setup, `fetch_url`, the `[embeddings]` and `[rerank]` blocks                                |
| [Code interpreter](docs/code-interpreter.md)     | The Pyodide sandbox, file round-trip, resource limits                                               |
| [Canvas](docs/canvas.md)                         | The side-by-side document the assistant drafts and revises across turns                             |
| [Prompt snippets](docs/prompt-snippets.md)       | Reusable prompt pieces: inserting, tagging, import and export                                       |
| [MCP servers](docs/mcp.md)                       | stdio/HTTP transports, the approval model, examples                                                 |
| [Push notifications](docs/notifications.md)      | VAPID keys, multi-device behavior, iOS install requirement                                          |
| [Deployment](docs/deployment.md)                 | Docker, reverse proxies (Caddy, nginx, Synology, Cloudflare), compression                           |
| [Importing from Open WebUI](docs/import-owui.md) | The one-shot migration script and its caveats                                                       |

## Need image / video generation?

[openai-api-bridge][bridge] is a companion project that aggregates
image/video/chat backends behind one OpenAI-compatible HTTP API: ComfyUI
workflows, Venice and ImageRouter image/video generation, OpenRouter
(including its chat-completions-shaped image generation), and any
OpenAI-compatible upstream as passthrough. Point GlyphStream at it and all
of those models show up in the picker alongside your chat backends.

## Stack

SvelteKit (adapter-node) · TypeScript · Tailwind v4 · Drizzle ORM (SQLite) ·
@simplewebauthn · bits-ui · Vitest + Playwright · pnpm.

## License

MIT — see `LICENSE`.

[bridge]: https://github.com/xiphux/openai-api-bridge
