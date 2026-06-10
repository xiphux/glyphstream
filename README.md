# GlyphStream

Lightweight chat frontend for any OpenAI-compatible backend.

GlyphStream sits in front of N OpenAI-compatible upstream endpoints
(llama-server, vLLM, Groq, OpenAI, [openai-api-bridge][bridge] for
ComfyUI/Venice, anything that speaks `/v1/chat/completions`) and aggregates
them into a single chat UI with one model picker.

- **Lightweight and fast.** Server-rendered + cached markdown,
  fine-grained reactivity (Svelte 5 runes), lean dependency tree, ~200 KB
  gzip client bundle, single-process deployment.
- **Multi-backend without per-frontend coupling.** Develops against the
  OpenAI spec, not against any specific upstream.
- **Image and video** rendering inline (when an upstream supports them via
  `/v1/images` or `/v1/videos`).
- **Permanent media storage.** Generated assets are pulled from upstream and
  stored locally on first generation; ref-counted; auto-purged after a grace
  period when no conversation references them.
- **Custom models** = preset of (base model + system prompt + params), like
  custom GPTs.
- **GitHub OAuth + passkey login** for safe self-hosting on the public
  internet — single-user-cap baked in.
- **PWA** — installable to iPhone homescreen.

[bridge]: https://github.com/xiphux/openai-api-bridge

> **Need image / video generation?** [openai-api-bridge][bridge] is a
> companion project that fronts ComfyUI workflows and Venice image
> generation behind an OpenAI-compatible HTTP API — point GlyphStream
> at it and the models show up in the picker alongside your chat
> backends.

## Stack

SvelteKit (adapter-node) · TypeScript · Tailwind v4 · Drizzle ORM (SQLite, dialect-portable) · arctic (GitHub OAuth) + @simplewebauthn (passkeys), custom Lucia-style session module · bits-ui for headless primitives · pnpm.

## Running locally

```bash
pnpm install
cp .env.example .env       # fill in AUTH_SECRET, optional GitHub OAuth
cp config.toml.example config.toml   # define at least one upstream
pnpm db:generate           # generate the initial migration
pnpm dev                   # http://localhost:5173
```

## Configuration

Two files, by concern:

- **`config.toml`** — endpoint definitions (one block per upstream). Safe to
  commit to a private repo because secrets live in env vars referenced by
  `*_env` field names.
- **`.env`** — auth secrets, optional GitHub OAuth credentials, file
  paths. Never committed.

See `config.toml.example` and `.env.example` for the full surface. The
[Authentication](#authentication) section below walks through the
sign-in methods and the env vars that gate them.

## Authentication

GlyphStream supports two sign-in methods, used independently or
together:

- **GitHub OAuth** — for operators who want SSO via GitHub.
- **Passkeys (WebAuthn)** — for biometric / hardware-key login. A
  passkey ceremony with `userVerification: required` is multi-factor
  by construction; no separate TOTP layer is needed.

Both can be toggled via `GITHUB_LOGIN_ENABLED` / `PASSKEY_LOGIN_ENABLED`
in `.env` (default: both on). At least one must remain enabled — the
server refuses to boot otherwise.

OAuth is **pure authentication against an existing binding** — never an
account-creation path. The first-run setup wizard at `/setup` creates
the operator account and binds the chosen first method (GitHub or
passkey). From then on, additional OAuth providers are linked
deliberately from **Settings → Security**. A GitHub callback for an
`external_id` that isn't already in `oauth_accounts` is refused with
`provider_not_bound`; there is no allowlist, no auto-create.

Revocation is a single column: setting `users.disabled_at` invalidates
every session and refuses every login method at the next request.

### First-run setup

On a fresh install with no users, visiting any page redirects to
`/setup`. Pick a display name (and optionally an email), then either
**Continue with GitHub** or **Set up a passkey**:

- **GitHub** runs a standard OAuth round-trip; the callback creates
  the user + binds the GitHub identity. Requires the OAuth app
  configuration in the next subsection.
- **Passkey** runs a WebAuthn registration ceremony; the verify step
  creates the user + binds the credential atomically (no orphans on
  abandon).

`/setup` closes the moment the first user exists — direct visits land
on `/login` instead. The operator can later add a second login method
(passkey on a GitHub-bootstrapped account, or vice versa) from
Settings → Security.

For deployments on a long-known subdomain that want defense in depth
against a "first visitor claims the account" race, set `SETUP_TOKEN`
in `.env` to a random value; `/setup` then requires `?token=<value>`
to render. The token has no effect once the first user exists.

### GitHub OAuth setup (optional)

Required only if you want GitHub as one of the sign-in methods. Skip
this whole section if you're going passkey-only.

#### 1. Create a GitHub OAuth App

Go to [github.com/settings/developers](https://github.com/settings/developers)
→ **New OAuth App**. Fill in:

| Field                          | Value                                                                                                                                                               |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Application name**           | Anything you like (e.g. `GlyphStream`)                                                                                                                              |
| **Homepage URL**               | Your public origin — same value you'll set for `EXTERNAL_BASE_URL`. Examples: `http://localhost:5173` for local dev, `https://glyphstream.example.com` for prod     |
| **Authorization callback URL** | The homepage URL + `/api/auth/github/callback`. E.g. `http://localhost:5173/api/auth/github/callback` or `https://glyphstream.example.com/api/auth/github/callback` |

After creation, click **Generate a new client secret** and capture both:

- **Client ID** → `GITHUB_OAUTH_CLIENT_ID` in `.env`
- **Client secret** → `GITHUB_OAUTH_CLIENT_SECRET` in `.env`

#### 2. Wire EXTERNAL_BASE_URL to the same origin

GlyphStream constructs the OAuth callback URL it sends to GitHub as
`${EXTERNAL_BASE_URL}/api/auth/github/callback`. This has to match the
**Authorization callback URL** registered in the GitHub app exactly —
scheme (`http` vs `https`), host, port (when non-default), no trailing
slash. A mismatch surfaces as GitHub's `"redirect_uri is not associated
with this application"` error after the user clicks Sign In.

```
# Local dev
EXTERNAL_BASE_URL=http://localhost:5173

# Production behind a reverse proxy
EXTERNAL_BASE_URL=https://glyphstream.example.com
```

> **Why `EXTERNAL_` instead of `PUBLIC_`?** SvelteKit reserves the
> `PUBLIC_` prefix for env vars exposed to browser code. A
> `PUBLIC_BASE_URL` would silently fail to read server-side and
> default to `localhost`, which then mismatches the OAuth callback in
> production. The `EXTERNAL_` prefix dodges that footgun.

### Passkeys

Once signed in (via the `/setup` wizard or by completing an OAuth
ceremony for an already-bound account), visit **Settings → Security**
to bind a passkey. Each registered passkey appears in the list with a
name, "Synced" / device-type badges, and when it was last used. You
can rename or remove passkeys at any time.

Multiple passkeys per account are supported and recommended — register
one per ecosystem (iCloud Keychain, 1Password / Bitwarden, etc.) so a
single outage doesn't lock you out. The "Add passkey" button respects
whichever authenticator the OS / browser offers, so picking a different
provider per registration is just a matter of accepting the right
prompt at the time.

> **Don't change `EXTERNAL_BASE_URL` after passkeys are registered.**
> GlyphStream derives the WebAuthn relying-party ID from its hostname;
> changing the value invalidates every existing credential, and
> affected users have to sign in via another bound method and
> re-register.

When `PASSKEY_LOGIN_ENABLED=0`, the "Add passkey" button hides but the
list stays visible so existing rows can be pruned.

## Auto-titling (optional)

By default, conversation titles in the sidebar are the first ~50
characters of the user's opening message. To get model-generated
titles instead, add a top-level `task_model` field **at the very top
of `config.toml`, above the first `[[endpoints]]` block**, naming a
model that one of those endpoints exposes:

```toml
# top of config.toml — before any [[endpoints]] or [table] header
task_model = "groq::llama-3.1-8b-instant"

[[endpoints]]
id = "groq"
# ...
```

The format is `endpoint_id::upstream_model_id` — the same namespaced
shape the model picker uses. After the first user+assistant exchange
in a new chat, GlyphStream calls this model once to produce a short
title and streams it on the same SSE channel as the assistant
response. Image and video chats run the title task in parallel with
asset generation, prompted from the user message alone.

Pick a **small, fast** model — title delivery has a 5-second SSE
budget so the title lands while the user is still watching the
message finish. Slower task models keep running in the background;
the title appears on the next sidebar refetch.

Misconfiguration (typo'd endpoint id, removed endpoint, upstream
failure) is non-fatal: titling silently reverts to the first-N-chars
preview and the rest of the response is unaffected. Users can also
rename any conversation manually via the sidebar **Rename** action —
manual renames win even if they race a running title task.

> **TOML scoping gotcha:** `task_model` is a top-level scalar, and TOML
> binds every bare key to the _most recently opened_ table header —
> there is no syntax to return to the root table once a header appears.
> So `task_model` must sit above **every** `[[endpoints]]` and
> `[table]` header in the file. Placed below an `[[endpoints]]` block
> it is parsed as a field of that endpoint, where endpoint validation
> ignores it as an unknown key and title generation reads a top-level
> `task_model` that isn't there — so titling silently stays in
> fallback mode with no error at boot.

## Tool calling (optional)

GlyphStream supports native OpenAI tool calling — the model decides
when to invoke a registered tool, GlyphStream runs it server-side, and
the result is folded back into the conversation. The built-in toolset:

- `get_current_time` — clock with optional IANA timezone.
- `fetch_url` — read a single web page or text resource by URL. Takes an
  optional `find` so long pages return the most relevant sections rather
  than the first 20 KB (see [Web reading & RAG](#web-reading--rag)).
- `web_search` — query a [SearxNG](https://docs.searxng.org/) instance
  (requires a `[search]` config block; see [Web search](#web-search)).
- `run_python` — execute Python in a sandboxed Pyodide interpreter,
  with file round-trip to the conversation's attachments (see
  [Code interpreter](#code-interpreter-python)).
- `save_memory` / `update_memory` / `forget_memory` — persist
  user-scoped facts the model surfaces between sessions.

The architecture is unbounded — adding more is a single file under
`src/lib/server/tools/`.

### Enable per endpoint

The OpenAI `/v1/models` shape doesn't tell clients which models accept
tools, so capability is configured per endpoint with an optional
`supports_tools = true` on the `[[endpoints]]` block:

```toml
[[endpoints]]
id = "openai"
base_url = "https://api.openai.com/v1"
api_key_env = "OPENAI_API_KEY"
supports_tools = true   # all GPT-4+ chat models accept tools
```

The flag is **endpoint-scoped** as a fallback. If the upstream
advertises tool support per model (the openai-api-bridge does this
for the OpenRouter backend, reading the `supported_parameters` field
from OpenRouter's catalog), GlyphStream prefers that per-model signal
and the endpoint flag is a default for models that don't self-report.
Defaults to `false` for safety — endpoints stay tool-disabled until
you opt them in.

### Model requirements

Tool calling **only works with models trained for it**. Even with the
config flag set, a model that wasn't fine-tuned for tool use will
either ignore the `tools` array or emit malformed `tool_calls`. As of
this writing, known-good local options include:

- Llama 3.1, 3.2, 3.3 Instruct (8B+)
- Qwen 2.5, 3 Instruct (7B+)
- Gemma 3 (12B+)
- Hermes-3
- Most Mistral instruct fine-tunes

Smaller / older models (Llama 2, anything ≤3B) typically flail.

### llama.cpp setup

`llama-server` supports OpenAI-shape tool calling out of the box. The
model's chat template (loaded via Jinja) is what surfaces tools to the
model, and Jinja templating is **on by default** in current
`llama-server` builds — you only need to act if you've explicitly
turned it off. If you've set `--no-jinja`, the `tools` array gets
silently dropped before the model ever sees it; drop the flag and
tools work.

Example launch:

```bash
llama-server --model qwen2.5-7b-instruct.gguf --host 0.0.0.0 --port 8080
```

Then in `config.toml`:

```toml
[[endpoints]]
id = "llama"
base_url = "http://192.168.1.20:8080/v1"
supports_tools = true
max_concurrent = 1
```

#### Limiting concurrency (`max_concurrent`)

`max_concurrent` caps how many generations run against an endpoint at
once. Extra requests **queue** (FIFO) and stream a "queued" state to the
client until a slot frees; the slot is held for the whole generation
(the entire stream / image / video job, not just the HTTP request).

It defaults to **4** when omitted — a friendly cap so a large
multi-model fan-out trickles instead of blasting the upstream all at
once. Set it to **1** for a single-GPU local backend (`llama-server`,
ComfyUI bridge) that can only hold one model in VRAM, so requests
serialize instead of thrashing or OOMing; raise it (up to 1024) for a
hosted provider that handles its own concurrency and you want more
parallelism. The gate is per **endpoint** (a single backend that
hot-swaps models still shares one VRAM pool), so a busy single-slot
endpoint queues across all conversations and all fan-out branches.

Because the cap is per endpoint, a bridge (like `openai-api-bridge`)
that fronts **both** a local GPU and cloud providers is best split into
**two endpoints** — one for the local providers with `max_concurrent =
1`, one for the cloud providers left uncapped — so the VRAM limit
applies only where it's needed. The bridge is a thin proxy (no model
weights live in it), so running a second container for this is cheap.

### Web search

The `web_search` tool is backed by [SearxNG](https://docs.searxng.org/),
a self-hosted meta-search engine. The model decides when a query needs
current information (events past its training cutoff, recent docs,
specific URLs to read) and calls it on its own — no per-conversation
"enable search" toggle.

The tool is **hidden from the model entirely** when SearxNG isn't
configured, so omitting the `[search]` block soft-disables the feature
without breaking anything else. The paired `fetch_url` tool is
**always available** — useful when you want the model to read a
specific link, with or without search.

**1.** Run a SearxNG instance. The official Docker image is the easy
path:

```bash
docker run -d --name searxng -p 8888:8080 searxng/searxng
```

**2.** Enable the JSON output format in SearxNG's `settings.yml` (the
default config only enables HTML):

```yaml
search:
  formats:
    - html
    - json
```

Restart the container after editing.

**3.** Add a `[search]` block to your `config.toml`:

```toml
[search]
url = "http://192.168.1.10:8888"
# api_key_env = "SEARXNG_API_KEY"   # optional; most instances need no auth
# timeout_seconds = 10              # optional; default 10
```

That's it — `web_search` is now in every tool-capable endpoint's
advertised toolset. The capability-named `[search]` section reserves
the namespace for future backend swaps (Brave, Tavily, Kagi) without
breaking existing configs.

**`fetch_url` extraction:** HTML pages are extracted with Mozilla's
[Readability](https://github.com/mozilla/readability) (the same
algorithm Firefox Reader View uses), which strips site chrome,
navigation, sidebars, comments, and ads down to just the article body
plus its title — typically 5-10x smaller than the raw page, and much
friendlier to the model's context. Pages Readability can't identify as
articles (search-result pages, directory indexes) fall through to a
coarser regex stripper. Raw response bodies are capped at 2 MB; the
final extracted text is capped at ~20 KB.

**`fetch_url` safety note:** to mitigate the model hallucinating an
internal URL (or following a redirect into one), `fetch_url` blocks
hostnames that resolve to private, loopback, link-local, CGNAT,
benchmark, multicast, or cloud-metadata addresses (10.x, 172.16-31.x,
192.168.x, 127.x, 169.254.x, IPv6 ULA/link-local, etc.). Operators who
want to point the model at LAN services aren't supported today; open
an issue if you have a real use case.

### Web reading & RAG

`fetch_url` accepts an optional `find` argument — a plain-language note
of what the model is looking for on the page. It only matters for long
pages: when the extracted text exceeds the ~20 KB budget, instead of
blindly keeping the first 20 KB, GlyphStream selects the **most relevant
sections** and returns those (in document order). The result's `mode`
field reports which path ran — `full` (page fit within budget),
`truncated` (over budget, no `find`), or `relevance` (over budget,
`find`-driven selection).

Selection is hybrid retrieval over the page's own structure:

- The article is chunked on its heading/paragraph boundaries, and each
  chunk is prefixed with a breadcrumb (`Page Title › Section › Subsection`)
  so a retrieved mid-document chunk keeps its context.
- **BM25** (lexical) scores every chunk — always on, no configuration,
  great for exact/rare terms (API names, error codes, identifiers).
- **Embedding cosine** (semantic) is added _when an `[embeddings]` model
  is configured_, and the two rankings are fused with Reciprocal Rank
  Fusion. This catches paraphrase matches BM25 misses (a query about
  "failures" matching a section titled "Resilience").

Without `[embeddings]`, selection runs BM25-only — still far better than
positional truncation. If the embedding endpoint is unreachable, slow, or
returns something malformed, selection silently **falls back to BM25**;
it never turns a fetch into an error.

To enable the embedding leg, add an `[embeddings]` block naming an
existing endpoint and an embedding model:

```toml
[embeddings]
endpoint_id = "nas-bridge"        # one of your [[endpoints]] ids
model_id = "text-embedding-3-small"
# timeout_seconds = 30            # optional; default 30
# max_input_tokens = 512          # optional; default 512 — the model's max
#                                 # input length; each embedded text is
#                                 # truncated to fit. Raise for big-context
#                                 # models (e.g. 8192).
# query_prefix = ""               # optional; default "". nomic/e5/bge/gte
# document_prefix = ""            # need "search_query: "/"search_document: ";
#                                 # OpenAI/Cohere-style models must NOT.
```

base_url and auth are inherited from the referenced endpoint. A bad
`endpoint_id` quietly disables embeddings (degrades to BM25) rather than
failing at boot. The same config also backs future embedding-based
features, so it's capability-named rather than `fetch_url`-specific.

> **Throughput matters.** Embedding dozens of chunks per long-page fetch
> is only practical on a reasonably fast embedding endpoint (GPU-backed,
> or a hosted provider). A slow CPU embedder will routinely exceed
> `timeout_seconds` and fall back to BM25 — which is fine, just not the
> hybrid path. BM25-only is the sensible mode when no fast embedder is
> available.

### MCP servers

[Model Context Protocol](https://modelcontextprotocol.io/) is a spec
for plugging external tool servers into a chat client. GlyphStream's
Node process connects to any `[[mcp_servers]]` declared in
`config.toml`, calls `tools/list` to discover what each server exposes,
and registers every discovered tool into the same registry the
built-ins use — so the model sees them as standard tool calls, and
the per-endpoint `supports_tools` flag gates them exactly like
`web_search` or `fetch_url`. One config edit unlocks the dozens of
public servers built against the spec (filesystem, GitHub, Linear, your
own internal services) with zero per-service integration code on the
GlyphStream side.

Two transports ship in v1:

- **`stdio`**: GlyphStream spawns the server as a child process and
  speaks line-delimited JSON-RPC over its stdin/stdout. Common for
  npm-published servers (`@modelcontextprotocol/server-filesystem`,
  etc.). The subprocess is **reaped after `idle_timeout_seconds` of
  inactivity** (default 900 — 15 minutes) and silently re-spawned
  on the next tool call, so a long-idle server doesn't keep a
  subprocess pinned for its memory footprint. Set
  `idle_timeout_seconds = 0` to keep the subprocess alive
  indefinitely.
- **`http`**: GlyphStream connects to a [Streamable HTTP](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http)
  endpoint. No idle reaper — HTTP keeps no expensive state at
  rest.

**1.** Add the server block(s) to your `config.toml`:

```toml
# Example: the official filesystem MCP server, scoped to /tmp.
[[mcp_servers]]
id = "fs"
display_name = "Filesystem"
transport = "stdio"
command = "npx"
args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]
# timeout_seconds = 30        # optional; per-call + connect timeout
# idle_timeout_seconds = 900  # optional; 0 disables stdio reaping
# Optional: pass extra env vars into the subprocess. Each value is the
# *name* of a GlyphStream-side env var to source from — same convention
# as the `*_env` fields elsewhere, so secrets stay out of this file.
# env_from = { LINEAR_API_KEY = "LINEAR_API_KEY" }

# Example: a hosted Streamable HTTP MCP server.
[[mcp_servers]]
id = "linear"
display_name = "Linear"
transport = "http"
url = "https://mcp.linear.app/mcp"
api_key_env = "LINEAR_MCP_KEY"   # optional; sent as Authorization: Bearer
```

**2.** Restart `pnpm dev`. The startup log warns about any server
that failed to connect; the rest of the boot continues — one bad
MCP server never blocks the others. Visit
**Settings → MCP servers** for the live status page (connected /
idle / failed, the tools each server advertised, and a per-tool
"Always allow" switch — more on that below).

**3.** Per-conversation gating: each server contributes its own
`mcp:<server-id>` opt-out category to the composer's feature
toggles popover, so the user can hide an entire server's toolset
from one turn without revoking trust. Custom-model presets can
default specific MCP categories off via the same per-category
checkboxes on the model edit page.

**Per-tool approval:** MCP tools default to **ask every time**. When
the model first calls one, the streaming relay halts, the in-flight
assistant bubble grows an inline **Allow / Allow Always / Reject**
prompt right where the tool call landed, and the composer disables
until the user picks. **Allow Always** persists the namespaced tool
name to the user's trusted-tools list so future calls bypass the
prompt entirely. Built-in tools (`get_current_time`, `web_search`,
`fetch_url`, memory) always execute inline — they're trusted by
virtue of being shipped. Manage grants from
**Settings → Permissions** (revoke any at any time) or
**Settings → MCP servers** (skim a server's toolset and bulk-trust
the ones you're comfortable with up front).

**Tool names** are namespaced as `mcp__<server-id>__<tool-name>`
in the upstream request so cross-server collisions are impossible
and a glance at a `tool_calls` log row tells you which server
served the call. Server IDs are constrained to lowercase
alphanumeric + dash; tool names are sanitized to fit OpenAI's
`[a-zA-Z0-9_-]{1,64}` spec if the upstream advertises anything
exotic.

**Deferred for later:** v1 is admin-defined with static auth only.
Per-user OAuth (for Gmail / Calendar / Drive MCP servers that need
a user-bound token), a browser-side bridge for MCP servers running
only on the user's laptop, image/audio blocks in tool results, and
argument-aware approval policies all live behind v1's seams — see
the MCP entry in `ROADMAP.md` for the phase-2 hook points.

### Code interpreter (Python)

The `run_python` tool gives the model a sandboxed Python 3 interpreter
backed by [Pyodide](https://pyodide.org/) running in a Node
`worker_threads` worker. One persistent interpreter per active
conversation: variables, imports, and user-defined functions stay
resident across turns, so a follow-up like _"now plot the residuals"_
just works without re-loading the dataframe. Workers are reaped after
5 minutes of idle (configurable) and re-spawn on the next call.

Pre-installed scientific stack: `numpy`, `pandas`, `matplotlib`,
`scipy`, `sympy`, `scikit-learn` (loaded on first use). The standard
library is available except `subprocess`, sockets, threads, and native
C extensions Pyodide doesn't ship. `micropip` is available for pure-
Python wheels and rides the same network gate (see below).

**File round-trip.** Files attached to messages in the conversation
are materialized into `/workspace/` before the call — uploads in the
composer's accept set (xlsx, csv, pdf, txt, json, images, ...) become
real files the model can `pd.read_excel(...)`, `open(...)`, etc. Any
file the call writes under `/workspace/` is persisted back as an
attachment on the assistant message: images and videos render inline
in the tool block, everything else (`.csv`, `.xlsx`, `.pdf`, …) shows
as a download chip. The next turn re-mounts those generated files, so
the model can build on its own previous outputs.

**Network reach.** Pyodide's `pyfetch` and the stdlib `urllib` /
`requests` shim all funnel through one `globalThis.fetch` chokepoint
that:

1. Honors the conversation's **Web access** toggle — turning it off
   in the composer popover blocks `pyfetch`, `urllib`, and
   `micropip.install` together, so the model can't end-around the
   toggle through Python.
2. Refuses private / loopback / link-local / CGNAT / cloud-metadata
   destinations (same SSRF policy as `fetch_url`).
3. Refuses any host configured as an `[[endpoints]]` upstream or as
   the SearxNG instance, so the model can't reach your bridge,
   upstream LLM, or search backend through the interpreter.

**Resource limits.** Each call has a wall-clock budget (default
30 s); on overrun the worker is terminated and the entry transitions
to "failed", so the next call re-spawns fresh (with prior in-memory
state gone — documented to the model in the tool's description). Each
worker carries a V8 old-space cap (default 512 MB); a runaway
allocation exits cleanly and the model gets a `memory-cap` error
instead of taking the Node process down. A pool cap (default 10)
LRU-evicts the least-recently-used idle interpreter when an 11th
conversation lights up.

**`config.toml` block — entirely optional, defaults below are what
ships:**

```toml
[code_interpreter]
enabled = true                  # master switch — false hides run_python entirely
pool_max = 10                   # max concurrent live workers (LRU-evicted past this)
idle_timeout_seconds = 300      # 5 min of inactivity → worker reaped
call_timeout_seconds = 30       # wall-clock per call → terminate on overrun
worker_memory_mb = 512          # V8 old-space cap per worker
# pyodide_index_url = ""        # leave empty to resolve from node_modules
```

Memory-wise: each warm interpreter sits at roughly 100–500 MB depending
on which packages got loaded, so the default `pool_max = 10` plus
`worker_memory_mb = 512` worst-cases at ~5 GB resident if every slot is
saturated. Tighten `pool_max` on lower-spec hosts; tighten
`idle_timeout_seconds` to reclaim memory faster between bursts of use.

**Per-conversation gating.** `run_python` lives in its own
`code_interpreter` feature category — one switch in the composer's
toggles popover. Default is on (when `enabled = true` at the config
level), per the same "all features on by default" rule the other
toggles follow. Custom-model presets can default the category off via
the per-category checkboxes on the model edit page.

**Not supported in v1:** streaming stdout (capture-and-return at end),
variable persistence across worker reaps (lost on idle / timeout /
OOM), workspace browse UI, micropip wheel cache, languages other than
Python. See the code-interpreter entry in `ROADMAP.md` for the phase-2
hook points already wired into v1's shape.

### Per-conversation feature toggles

The composer surfaces a small popover (the sliders icon next to the
attach button) with one switch per opt-out _category_:

- **Web access** disables both `web_search` and `fetch_url` together,
  so the model can't compose around partial gating by `fetch_url`-ing
  a search-engine URL directly. The two web-touching tools share a
  `web` category and the single switch closes the whole egress path.
- **Personalization** suppresses the prefs-derived persona (your
  Name / About you / Custom instructions) that would otherwise be
  injected as the system message AND turns off the memory tools
  (`save_memory` / `update_memory` / `forget_memory`) so a privacy-
  sensitive turn can't grow the saved memory store. Has no effect on
  conversations that carry an explicit system prompt or were started
  from a custom-model preset — those already snapshot whatever prompt
  _they_ declared.
- **Code interpreter** disables `run_python` for the turn. The web
  toggle above still independently controls Python's network egress
  (so a code-allowed but web-blocked turn runs pure compute with no
  outbound traffic, including `micropip`).
- **One toggle per configured MCP server** (`mcp:<server-id>`,
  labeled with the server's `display_name`). Closes off every tool
  that server advertises in one switch — the natural unit of trust
  for a multi-tool MCP server. See [MCP servers](#mcp-servers) above
  for the broader trust model.

Why category-level rather than one switch per tool: an opt-out
motivated by privacy is a security boundary, not a UX grouping. The
`web` category bundling described above is the same instinct behind
keeping `personalization` broad (persona + memory together) and
behind bundling every MCP-server tool under one toggle — a single
switch seals every avenue along that axis instead of asking the user
to remember which sub-tools matter.

Defaults are **all features on** for every new conversation — never
sticky across sessions, since a one-time off-flip carrying forward
silently would undermine the privacy intent. Toggles flipped in an
existing chat apply forward from the next message; history already on
the page is unaffected.

### Adding more tools

Each tool is a TypeScript module under `src/lib/server/tools/` that
exports an OpenAI tool definition + an `execute(args, ctx)` function,
registered via `register(...)` at module load. The
[`get_current_time` implementation](src/lib/server/tools/clock.ts) is
the smallest end-to-end example; copy its shape, add an import line
in `src/lib/server/tools/index.ts`, and the new tool is live for
every endpoint with `supports_tools = true`. Tools backed by optional
config (like `web_search` is by `[search]`) can implement
`isAvailable()` to hide themselves when their backend isn't present.
Tools that should be reachable from the per-conversation opt-out
panel declare a `category` in their `metadata` (see
`BUILTIN_FEATURE_CATEGORIES` in `$lib/types/api`).

For one-off custom logic, an in-tree tool is the right level. If the
capability you want is generic enough that other people would also
want it — or if it already exists as a published MCP server — point
GlyphStream at the MCP server in `config.toml` instead (see
[MCP servers](#mcp-servers) above). No code changes needed; the
runtime registry picks it up at boot.

## Push notifications (optional)

GlyphStream can fire OS-level push notifications when an assistant
message finishes — useful for multi-minute video generations, or just
walking away from a long answer. The feature is **off by default**;
without VAPID keys configured, the master switch in **Settings →
Preferences → Notifications** stays inert and the rest of the app is
unaffected. To enable:

### 1. Generate a VAPID keypair

```bash
npx web-push generate-vapid-keys
```

The public key is fine to commit; the private key is a secret.

### 2. Add a `[notifications]` block to `config.toml`

```toml
[notifications]
vapid_public = "BPI...your-public-key..."
vapid_private_env = "VAPID_PRIVATE_KEY"
vapid_subject = "mailto:admin@example.com"
```

The `vapid_private_env` field is the **name** of the env var holding
the private key, following the same `*_env` convention as endpoint API
keys — the secret never lives in `config.toml`.

### 3. Set the private key in `.env`

```
VAPID_PRIVATE_KEY=your-private-key-here
```

Restart the server. Users can now opt in via **Settings → Preferences
→ Notifications**.

> **iPhone / iPad users:** iOS Safari only delivers push to PWAs
> installed to the Home Screen. Open GlyphStream in Safari → share
> sheet → **Add to Home Screen**, then launch the app from the icon
> (not the Safari tab) before enabling notifications. The settings UI
> detects this and shows a hint when the install step is missing.

See `docs/notifications.md` for the full feature: privacy model,
multi-device behavior, troubleshooting, and developer reference.

## Deployment

Multi-stage Alpine Docker image, ~200 MB final size. Bind-mount `data/` for
persistence and mount `config.toml` read-only:

```bash
mkdir -p /srv/glyphstream/{data,imports}
cd /srv/glyphstream
cp /path/to/repo/.env.example .env       # then edit
cp /path/to/repo/config.toml.example config.toml  # then edit
cp /path/to/repo/docker-compose.yml .
docker compose up -d --build
curl http://localhost:3000/api/health
```

Drizzle migrations apply automatically on first DB open. Subsequent
config or env changes only need `docker compose restart` — no rebuild.

## Importing from Open WebUI

GlyphStream ships a one-shot script for migrating chat history out of
Open WebUI. It walks OWUI's tree-shaped export into the matching
GlyphStream schema, splits reasoning blocks (`<details type="reasoning">`)
into structured parts, and renders assistant markdown to HTML so the UI
shows formatted output immediately.

```bash
# 1. In OWUI: Settings → "Export All Chats" → save the JSON file.

# 2. Drop the export onto the host alongside docker-compose.yml.
mkdir -p /srv/glyphstream/imports
cp ~/Downloads/owui-export.json /srv/glyphstream/imports/

# 3. Find your GlyphStream user id (you must have logged in via OAuth
#    at least once for the row to exist).
docker compose exec glyphstream sqlite3 /app/data/glyphstream.db \
  "SELECT id, github_username FROM users;"

# 4. Dry-run first to see counts without writing.
docker compose exec glyphstream node /app/build/scripts/import-owui.js \
  /app/imports/owui-export.json --user-id <your-uuid> --dry-run

# 5. Real run.
docker compose exec glyphstream node /app/build/scripts/import-owui.js \
  /app/imports/owui-export.json --user-id <your-uuid>
```

Caveats:

- Imported conversations get a synthetic `endpoint_id = 'imported-owui'` —
  full history is preserved and viewable, but sending a _new_ message in
  an imported conversation will fail with "endpoint not configured" until
  a future "reassign endpoint" UI lands.
- OWUI's export references images by URL to its own file API; once OWUI
  is shut down those URLs 404. The script rewrites image references to
  an `_[image unavailable]_` placeholder so the surrounding text still
  reads coherently.
- Re-running the script will create duplicates (no idempotency check yet).
  To re-import cleanly, wipe previous imports first:
  `sqlite3 /app/data/glyphstream.db "DELETE FROM conversations WHERE endpoint_id = 'imported-owui';"`

For local dev (no Docker): `pnpm import:owui <export.json> --user-id <uuid>`.

## Public exposure (TLS + HTTP/2)

adapter-node speaks HTTP/1.1 only. Put a reverse proxy in front for
TLS + HTTP/2 (and HTTP/3 if you want it). Set `EXTERNAL_BASE_URL` in `.env`
to the public origin so the OAuth redirect URI matches.

Any pass-through reverse proxy works — pre-compression of static assets
is handled inside Node, so as long as the proxy forwards
`Accept-Encoding` (which all do by default) the brotli/gzip variants
reach the client unchanged. Tested with:

- **Synology DSM Reverse Proxy** (Login Portal → Advanced → Reverse
  Proxy). Source: `https://glyphstream.{your}.synology.me:443` →
  Destination: `localhost:3000`. Tick "Enable HTTP/2". Synology
  manages the cert via Let's Encrypt for `*.synology.me`. Synology
  does NOT expose a dynamic-compression option — set
  `COMPRESS_DYNAMIC=1` in `.env` (see below) to compress SSR HTML +
  API JSON inside GlyphStream instead.
- **Caddy** — `glyphstream.example.com { reverse_proxy 127.0.0.1:3000 }`.
  Auto-TLS, HTTP/2 + HTTP/3 on by default. Caddy compresses dynamic
  responses automatically and skips already-encoded static ones — no
  need to set `COMPRESS_DYNAMIC`.
- **Nginx** — `proxy_pass http://127.0.0.1:3000;` + `listen 443 ssl http2;`.
  Don't enable `gzip on` for the static `/_app/immutable/*` location
  or you'll double-compress; do enable it for the dynamic paths (or
  set `COMPRESS_DYNAMIC=1` and skip nginx-side gzip entirely). Either
  way, exclude `text/event-stream` so chat streaming isn't buffered.
- **Cloudflare Tunnel** — works as a transparent passthrough. Cloudflare
  compresses dynamic responses at the edge automatically.

### Dynamic-response compression (`COMPRESS_DYNAMIC`)

Off by default — most reverse proxies (Caddy, nginx with proper config,
Cloudflare) compress dynamic responses themselves, and doing it in both
places is wasted CPU. Turn it on when the proxy in front _can't_
compress (Synology's built-in proxy is the canonical case):

```
COMPRESS_DYNAMIC=1
```

When enabled, GlyphStream picks the best codec the client advertises:
**zstd > brotli > gzip**. zstd at default level is the fastest of the
three on modern CPUs; the fallbacks cover older browsers. SSE
(`text/event-stream`) is always skipped so the chat-stream UI keeps
flushing events as they arrive. Static `/_app/immutable/*` assets are
already precompressed at build time and aren't affected by this flag.

## License

MIT — see `LICENSE`.
