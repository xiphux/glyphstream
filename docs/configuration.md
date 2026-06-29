# Configuration

GlyphStream is configured through two files, split by concern:

- **`config.toml`** — endpoint definitions (one block per upstream) and
  feature blocks. Safe to commit to a private repo because secrets live in
  env vars referenced by `*_env` field names.
- **`.env`** — auth secrets, optional GitHub OAuth credentials, file paths.
  Never committed.

See [`config.toml.example`](../config.toml.example) and
[`.env.example`](../.env.example) for the full annotated surface. This page
covers the concepts and the gotchas.

## The `*_env` secrets convention

Any `config.toml` field whose name ends in `_env` stores the **name** of an
environment variable, never the secret itself:

```toml
[[endpoints]]
id = "groq"
base_url = "https://api.groq.com/openai/v1"
api_key_env = "GROQ_API_KEY"   # the key lives in .env as GROQ_API_KEY=...
```

The same convention applies everywhere a secret is needed — endpoint API
keys, `vapid_private_env` for [push notifications](notifications.md), MCP
server `api_key_env` / `env_from` ([MCP guide](mcp.md)).

## Endpoints

Each `[[endpoints]]` block defines one OpenAI-compatible upstream. Models
from every endpoint are aggregated into one picker, with model IDs
internally namespaced as `{endpoint_id}::{upstream_model_id}`.

```toml
[[endpoints]]
id = "llama"                          # stable internal id — don't rename casually
display_name = "Llama (main)"         # picker group label
base_url = "http://192.168.1.20:8080/v1"
# api_key_env = "LLAMA_KEY"           # omit for no Authorization header
# request_timeout_seconds = 600
# supports_tools = true               # see the tool-calling guide
# max_concurrent = 1                  # see "Limiting concurrency" below
# context_window = 32768              # fallback token budget; see "Context window" below
# model_context_windows = { "Gemma4-26B" = 40960 }  # per-model override; see "Context window"
# provider_quirk = "deepseek-r1"      # passthrough | deepseek-r1 | openai-o-series | openrouter
# group_by = "owned_by"               # bucket picker entries by the model's owned_by
```

- **`provider_quirk`** opts the endpoint's streams into a per-vendor
  normalizer (reasoning-block formats and the like). If omitted, GlyphStream
  auto-detects from upstream model id substrings; the default is
  `passthrough`.
- **`group_by = "owned_by"`** is useful for aggregating proxies
  ([openai-api-bridge][bridge]) that expose many real providers under one
  endpoint — the picker buckets by each model's `owned_by` field instead of
  putting everything under one group.

[bridge]: https://github.com/xiphux/openai-api-bridge

## Limiting concurrency (`max_concurrent`)

`max_concurrent` caps how many generations run against an endpoint at once.
Extra requests **queue** (FIFO) and stream a "queued" state to the client
until a slot frees; the slot is held for the whole generation (the entire
stream / image / video job, not just the HTTP request).

It defaults to **4** when omitted — a friendly cap so a large multi-model
fan-out trickles instead of blasting the upstream all at once. Set it to
**1** for a single-GPU local backend (`llama-server`, ComfyUI bridge) that
can only hold one model in VRAM, so requests serialize instead of thrashing
or OOMing; raise it (up to 1024) for a hosted provider that handles its own
concurrency and you want more parallelism. The gate is per **endpoint** (a
single backend that hot-swaps models still shares one VRAM pool), so a busy
single-slot endpoint queues across all conversations and all fan-out
branches.

Because the cap is per endpoint, a bridge (like `openai-api-bridge`) that
fronts **both** a local GPU and cloud providers is best split into **two
endpoints** — one for the local providers with `max_concurrent = 1`, one for
the cloud providers left uncapped — so the VRAM limit applies only where
it's needed. The bridge is a thin proxy (no model weights live in it), so
running a second container for this is cheap.

## Context window (`context_window`)

A bar above the message composer shows a thread's running size against the
model's context window — `27,725 / 40,960 tokens`, turning amber as it nears the
limit — so you can see how much room is left as you type. It needs to know the window size, and the
OpenAI `/v1/models` row has no field for it, so GlyphStream resolves it in
this order (most specific first):

1. **`model_context_windows`** from the endpoint config — a per-model override
   keyed by the upstream model id (the id as it appears in the picker, _before_
   GlyphStream's `endpoint::` prefix; for an aggregating bridge that's the
   provider-prefixed id, e.g. `llama/Gemma4-26B`, not the bare `Gemma4-26B`).
   This is the operator's explicit statement and wins over everything below, so
   reach for it when auto-detect can't see the value (e.g. behind the bridge
   before you redeploy it, or a backend that advertises nothing) or when you
   want to pin a deliberate value. Both TOML forms work — inline:

   ```toml
   [[endpoints]]
   id = "llama"
   base_url = "http://192.168.1.20:8081/v1"
   model_context_windows = { "Gemma4-26B" = 40960, "GLM-4.7-Flash" = 65536 }
   ```

   …or a sub-table (binds to the `[[endpoints]]` block above it), nicer when
   you have many models:

   ```toml
   [endpoints.model_context_windows]
   "Gemma4-26B" = 40960
   "GLM-4.7-Flash" = 65536
   ```

2. **Auto-detected per model**, when the upstream surfaces it. Covered today:
   - **llama.cpp** — `meta.n_ctx` on a model that's currently loaded, and
     (router/model-swap builds) the child's `--ctx-size` launch arg, which is
     readable even while the model is idle. So in router mode each model gets
     its own window automatically — you only need `model_context_windows` to
     override or when the value can't be read.
   - **vLLM** — `max_model_len`.
   - **[openai-api-bridge][bridge]** — normalizes the above into a single
     `context_window` field (the bridge otherwise strips the `meta`/`status`
     blocks that carry it, so without this the budget would be lost behind the
     bridge).
3. **`context_window`** from the endpoint config — a blanket per-endpoint
   fallback for upstreams that advertise nothing per model (raw OpenAI, Groq,
   …). The per-model layers above win when present.
4. **Unknown** — the header falls back to showing just the running token
   count, with no ceiling.

The auto-detected value is resolved from the model list rather than frozen
onto the conversation, so if you restart `llama-server` with a different
`--ctx-size`, the budget follows — on the next models-list load (opening a
chat, or the 60s stale-while-revalidate refresh), not instantly mid-session.
A `model_context_windows` override is static until you edit it. The running
count itself is the upstream-reported `prompt_tokens + completion_tokens` of
the latest response, so it reflects the real tokenizer, not an estimate.

The known window also powers **context compaction**: each user picks, in
Preferences ▸ Context compaction, whether GlyphStream should automatically
summarize older history once a thread crosses a percentage of this window
(default 80%). Without a known window, automatic compaction can't fire — but
the manual "Compact" button (in the bar above the composer) still works. (This
is a user preference, not a server config setting.)

[bridge]: https://github.com/xiphux/openai-api-bridge

## Auto-titling (`task_model`)

By default, conversation titles in the sidebar are the first ~50 characters
of the user's opening message. To get model-generated titles instead, add a
top-level `task_model` field **at the very top of `config.toml`, above the
first `[[endpoints]]` block**, naming a model that one of those endpoints
exposes:

```toml
# top of config.toml — before any [[endpoints]] or [table] header
task_model = "groq::llama-3.1-8b-instant"

[[endpoints]]
id = "groq"
# ...
```

The format is `endpoint_id::upstream_model_id` — the same namespaced shape
the model picker uses. After the first user+assistant exchange in a new
chat, GlyphStream calls this model once to produce a short title and streams
it on the same SSE channel as the assistant response. Image and video chats
run the title task in parallel with asset generation, prompted from the user
message alone.

Pick a **small, fast** model — title delivery has a 5-second SSE budget so
the title lands while the user is still watching the message finish. Slower
task models keep running in the background; the title appears on the next
sidebar refetch.

Misconfiguration (typo'd endpoint id, removed endpoint, upstream failure) is
non-fatal: titling silently reverts to the first-N-chars preview and the
rest of the response is unaffected. Users can also rename any conversation
manually via the sidebar **Rename** action — manual renames win even if they
race a running title task.

> **TOML scoping gotcha:** `task_model` is a top-level scalar, and TOML
> binds every bare key to the _most recently opened_ table header — there is
> no syntax to return to the root table once a header appears. So
> `task_model` must sit above **every** `[[endpoints]]` and `[table]` header
> in the file. Placed below an `[[endpoints]]` block it is parsed as a field
> of that endpoint, where endpoint validation ignores it as an unknown key
> and title generation reads a top-level `task_model` that isn't there — so
> titling silently stays in fallback mode with no error at boot.

## Image prompt enhancement (`[image_enhancement]`)

Different image models want their prompts in very different shapes — a
plain-English narrative for Flux/Qwen/Krea, strict Danbooru tags for
Illustrious/WAI, "keyword soup" for SDXL fine-tunes, or a hybrid. When this is
configured, GlyphStream sends an image prompt to an LLM first, which rewrites it
into the **target model's preferred format** (and expands it if it's vague),
then generates from the rewritten prompt. Your original message is kept
verbatim; the gallery lightbox shows the enhanced prompt with an
**"Enhanced — show original"** toggle.

It's opt-in and entirely non-fatal: with no `[image_enhancement]` block, prompts
pass through unchanged; if the enhancer model errors or times out, the original
prompt is used. It runs **per generation**, so a multi-model fan-out enhances
each branch for its own target model. It is **skipped for image-to-image edits**
(an edit instruction isn't a scene description) and can be turned off
per-conversation from the composer's feature menu ("Image prompt enhancement").

Add the block at the **top of `config.toml`** (above the first `[[endpoints]]`,
same scoping rule as `task_model`):

```toml
[image_enhancement]
model = "groq::llama-3.3-70b-versatile"   # endpoint_id::upstream_model_id
# max_tokens = 400                         # optional cap per rewrite
# temperature = 0.7                        # optional
# [image_enhancement.style_instructions]   # optional: override the built-in
#   "booru-tags" = "..."                   #   wording for a given style
```

Pick a **capable** model — prompt rewriting benefits from a stronger model than
auto-titling, so this is a separate slot from `task_model`. Misconfiguration
(typo'd endpoint, removed endpoint) silently disables enhancement.

Enhancement runs **off** the image endpoint's generation slot, acquiring the
_enhancer_ endpoint's own concurrency slot instead — so an enhancer on a
separate endpoint runs in parallel with image generation, while one that shares
the image endpoint serializes against it. If your enhancer is a local model
that can't handle many simultaneous requests (e.g. a single llama.cpp instance),
**bound it with `max_concurrent` on its GlyphStream endpoint** rather than with
the server's own parallelism flag (llama.cpp `--parallel`). Both prevent the
backend from thrashing on a multi-model fan-out, but GlyphStream's queue runs
**in the grid's order**, whereas the server's internal parallelism completes
requests in roughly arbitrary order — which scrambles the order results land in
the compare grid. (`max_concurrent = 1` on the enhancer endpoint gives the
cleanest, in-order behavior for a single-instance CPU model.)

### Telling GlyphStream which model wants which style

The enhancer needs to know each image model's preferred format. Two sources,
checked in order (config wins):

1. **Per-endpoint config override** — keyed by the _upstream_ model id, exactly
   like `model_context_windows`:

   ```toml
   [[endpoints]]
   id = "comfy"
   # ...
   [endpoints.model_prompt_styles]
     "illustrious-xl" = "booru-tags"
     "flux-2-klein"   = "natural-language"
   [endpoints.model_prompt_hints]
     "illustrious-xl" = "prefix with: masterpiece, best quality, amazing quality; never use score_N tags"
     "z-image-turbo"  = "keep it under ~60 words, front-load the subject"
   ```

2. **Upstream metadata** — an [openai-api-bridge](https://github.com/xiphux/openai-api-bridge)
   ComfyUI workflow can declare `prompt_style` / `prompt_hint` in its
   `meta.json`, and GlyphStream reads them from `/v1/models`. The config override
   above always wins over this.

Styles are one of `natural-language`, `booru-tags`, `keyword-soup`, `hybrid`,
`json` (loose aliases like `narrative`, `danbooru`, `tags`, `structured` are
accepted). A model with **no** style resolved still gets a gentler
**clarify-only** pass that expands a vague prompt while preserving the format you
wrote — it never restyles blindly. The optional `prompt_hint` is freeform text
appended to the enhancer's instructions, for nuance the styles can't carry — and
for `json` it's where the **exact field schema** goes, since the JSON shape is
model-specific.

#### Recommended styles for common models

| Model(s)                      | `prompt_style`     | hint highlights                                                |
| ----------------------------- | ------------------ | -------------------------------------------------------------- |
| Flux 2 Klein, Krea 2          | `natural-language` | concrete camera/film terms, not "8k/masterpiece"               |
| Qwen Image, ERNIE Image Turbo | `natural-language` | explicit layout; ERNIE/Qwen have their own enhancer — see note |
| Z-Image Turbo                 | `natural-language` | short (~40–70 words), front-load subject                       |
| Illustrious, WAI              | `booru-tags`       | quality-tag prefix; **no `score_N` tags**                      |
| Lustify, ChromaHD             | `keyword-soup`     | cinematic/photography phrases, camera + film                   |
| Anima                         | `hybrid`           | tags→prose; spaces not underscores; `@artist`                  |
| Ideogram 4                    | `json`             | the JSON field schema (see below)                              |

`json` (e.g. **Ideogram 4**, trained exclusively on JSON captions): the style
emits a JSON object, but the schema is the model's — put it in the hint. For
Ideogram 4, something like:

```toml
[endpoints.model_prompt_hints]
  "ideogram-4" = "JSON fields: high_level_description (1-2 sentences); style_description (medium, lighting, and a colour_palette array of hex colors); compositional_deconstruction (background element first, then each foreground object, with a short description and optional bbox [x,y,w,h]). Output only the JSON."
```

One gotcha for `json`: make sure the model's workflow actually accepts JSON in
its prompt field (Ideogram's ComfyUI node does) — the enhancer just produces the
JSON string; the downstream has to consume it. (The default `max_tokens` is
sized to fit a structured prompt, so you only need to raise it for unusually
complex JSON scenes.)

> **Double-enhancement caveat:** some upstreams run their _own_ prompt enhancer
> (Qwen on DashScope via `prompt_extend`, ERNIE-Image via `use_pe`), both default-
> on. Stacking GlyphStream's enhancer on top double-expands and dilutes intent —
> disable the upstream one, or turn GlyphStream enhancement off for those models.

## Feature blocks

Each optional feature gets its own capability-named block, documented in its
own guide:

| Block                 | Feature                                                                  | Guide                                                |
| --------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `[search]`            | `web_search` via SearxNG                                                 | [Web search & RAG](web-search.md)                    |
| `[embeddings]`        | semantic retrieval (`fetch_url`, `recall_memory`, gallery prompt search) | [Web search & RAG](web-search.md)                    |
| `[image_enhancement]` | LLM prompt rewriting for image models                                    | [above](#image-prompt-enhancement-image_enhancement) |
| `[code_interpreter]`  | the sandboxed Python runtime                                             | [Code interpreter](code-interpreter.md)              |
| `[[mcp_servers]]`     | external Model Context Protocol servers                                  | [MCP servers](mcp.md)                                |
| `[tools]`             | tool-loop iteration cap                                                  | [MCP servers](mcp.md#deferred-tools-tool-search)     |
| `[notifications]`     | web push                                                                 | [Push notifications](notifications.md)               |

## `.env` reference

The annotated [`.env.example`](../.env.example) is canonical. Highlights:

- `AUTH_SECRET` — required; random 32+ byte hex string
  (`openssl rand -hex 32`).
- `EXTERNAL_BASE_URL` — the public origin, used to build OAuth callback URLs
  and the WebAuthn relying-party ID. See the
  [authentication guide](authentication.md) for the footguns.
- `DB_PATH` / `MEDIA_DIR` — SQLite file and media directory locations.
  Generated media is kept indefinitely; the background purger only reaps
  _abandoned uploads_, on a fixed cadence (15-minute sweep, 30-minute
  grace) that isn't configurable.
- `GITHUB_LOGIN_ENABLED` / `GOOGLE_LOGIN_ENABLED` / `OIDC_LOGIN_ENABLED` /
  `PASSKEY_LOGIN_ENABLED` — toggle the sign-in methods. GitHub + passkey
  default on; Google + OIDC default off. At least one method must remain
  _usable_ — an OAuth provider's button only appears when its flag is on AND
  its credentials are set, and the server refuses to boot if nothing is
  usable.
- OAuth provider credentials — `GITHUB_OAUTH_CLIENT_ID` /
  `GITHUB_OAUTH_CLIENT_SECRET`, `GOOGLE_OAUTH_CLIENT_ID` /
  `GOOGLE_OAUTH_CLIENT_SECRET`, and for generic OIDC `OIDC_ISSUER` /
  `OIDC_CLIENT_ID` / `OIDC_CLIENT_SECRET` (plus optional `OIDC_DISPLAY_NAME`
  and `OIDC_SCOPES`). See the [authentication guide](authentication.md) for
  the per-provider setup and exact callback URLs.
- `MCP_SECRET_KEY` — optional; encrypts per-user MCP credentials at rest.
  Defaults to `AUTH_SECRET`, so per-user MCP needs no extra setup — set it
  only to rotate that encryption independently ([MCP guide](mcp.md#authentication)).
- `COMPRESS_DYNAMIC` — compress SSR HTML + API JSON in-process when the
  reverse proxy can't ([deployment guide](deployment.md)).

Config or env changes only need a restart (`docker compose restart`) — no
rebuild.
