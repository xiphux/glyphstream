# MCP servers

[Model Context Protocol](https://modelcontextprotocol.io/) is a spec for
plugging external tool servers into a chat client. GlyphStream's Node
process connects to any `[[mcp_servers]]` declared in `config.toml`, calls
`tools/list` to discover what each server exposes, and registers every
discovered tool into the same registry the built-ins use — so the model sees
them as standard tool calls, and the per-endpoint `supports_tools` flag
gates them exactly like `web_search` or `fetch_url`. One config edit unlocks
the dozens of public servers built against the spec (filesystem, GitHub,
Linear, your own internal services) with zero per-service integration code
on the GlyphStream side.

## Transports

Two transports ship in v1:

- **`stdio`**: GlyphStream spawns the server as a child process and speaks
  line-delimited JSON-RPC over its stdin/stdout. Common for npm-published
  servers (`@modelcontextprotocol/server-filesystem`, etc.). The subprocess
  is **reaped after `idle_timeout_seconds` of inactivity** (default 900 —
  15 minutes) and silently re-spawned on the next tool call, so a long-idle
  server doesn't keep a subprocess pinned for its memory footprint. Set
  `idle_timeout_seconds = 0` to keep the subprocess alive indefinitely.
- **`http`**: GlyphStream connects to a
  [Streamable HTTP](https://modelcontextprotocol.io/docs/concepts/transports#streamable-http)
  endpoint. No idle reaper — HTTP keeps no expensive state at rest.

## Setup

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

**2.** Restart the server. The startup log warns about any server that
failed to connect; the rest of the boot continues — one bad MCP server never
blocks the others. Visit **Settings → MCP servers** for the live status page
(connected / idle / failed, the tools each server advertised, and a per-tool
"Always allow" switch — more on that below).

**3.** Per-conversation gating: each server contributes its own
`mcp:<server-id>` opt-out category to the composer's feature toggles
popover, so the user can hide an entire server's toolset from one turn
without revoking trust. Custom-model presets can default specific MCP
categories off via the same per-category checkboxes on the model edit page.

## Authentication

Each server authenticates one of two ways, set by its `auth` field:

- **`auth = "global"`** (the default) — one shared credential for the whole
  instance, read from the env var named in `api_key_env` at boot and sent as
  `Authorization: Bearer <token>`. Right for a server fronting a shared
  resource (an internal service, a team Linear workspace).
- **`auth = "per_user"`** — each user supplies their **own** token, so a
  server fronting a personal account (email, calendar) works in a multi-user
  deployment. HTTP transport only, and it must **not** set `api_key_env` (the
  token is per user, not from the environment):

```toml
[[mcp_servers]]
id = "email"
display_name = "Email"
transport = "http"
url = "https://api.fastmail.com/mcp"
auth = "per_user"
```

A per-user server appears to everyone in **Settings → MCP servers** with a
**Your credential** field. Until a user saves a token there it shows as
`needs credential` and **none of its tools are advertised to that user** — the
model never sees them. Once saved, the connection is made lazily under that
user's identity and its tools join their registry; clearing the token drops
them again.

Tokens are encrypted at rest with AES-256-GCM, keyed `(serverId, userId)`. The
key is `MCP_SECRET_KEY`, which **defaults to `AUTH_SECRET`** — so per-user MCP
needs no extra setup. Set it explicitly only to rotate MCP-credential
encryption independently of session secrets; rotating whichever key is in
effect invalidates every stored credential, and users re-enter their tokens.
See the [`.env` reference](configuration.md#env-reference).

## Per-tool approval

MCP tools default to **ask every time**. When the model first calls one, the
streaming relay halts, the in-flight assistant bubble grows an inline
**Allow / Allow Always / Reject** prompt right where the tool call landed,
and the composer disables until the user picks. **Allow Always** persists
the namespaced tool name to the user's trusted-tools list so future calls
bypass the prompt entirely. Built-in tools (`get_current_time`,
`web_search`, `fetch_url`, memory) always execute inline — they're trusted
by virtue of being shipped. Manage grants from **Settings → Permissions**
(revoke any at any time) or **Settings → MCP servers** (skim a server's
toolset and bulk-trust the ones you're comfortable with up front).

## Tool naming

Tool names are namespaced as `mcp__<server-id>__<tool-name>` in the upstream
request so cross-server collisions are impossible and a glance at a
`tool_calls` log row tells you which server served the call. Server IDs are
constrained to lowercase alphanumeric + dash; tool names are sanitized to
fit OpenAI's `[a-zA-Z0-9_-]{1,64}` spec if the upstream advertises anything
exotic.

## Deferred tools (tool search)

Every enabled tool's full definition — name, description, and complete
JSON-Schema parameters — is sent on **every** request. A server with many tools
(the GitHub MCP advertises ~45) can spend tens of thousands of tokens on
definitions a given turn never uses. On the small-context local models this
project targets — often pinned well under 100k tokens by VRAM — that alone can
crowd out the conversation.

Set `defer_tools = true` on a server to hide its tools from the default tool
list:

```toml
[[mcp_servers]]
id = "github"
display_name = "GitHub"
transport = "http"
url = "https://api.githubcopilot.com/mcp/"
api_key_env = "GITHUB_MCP_KEY"
defer_tools = true   # optional; default false
```

The model then discovers them on demand through a built-in **`search_tools`**
tool: it writes a short capability query (e.g. "create a github issue"), and
GlyphStream ranks the deferred catalog and returns the top few matches, which
become callable in the same turn. Ranking is **hybrid** — keyword (BM25) always,
fused with **semantic** similarity when an
[`[embeddings]`](web-search.md#the-embeddings-block) block is configured (it
degrades to keyword-only otherwise). The system prompt carries
a one-line hint listing the deferred servers and their tool counts so the model
knows what's searchable without paying the per-tool cost.

A tool the model searches up **stays loaded for the rest of the conversation**
(recovered by scanning the active branch), so it doesn't re-search every turn.
Switching to a different message branch scopes this naturally — only the tools
that branch activated come back. Deferred tools still honor the per-conversation
`mcp:<id>` toggle: disable a server for a chat and it disappears from the catalog
(and any already-loaded tools drop) for that chat.

Because tool search adds a round-trip (search, then call), the per-turn tool-loop
cap is **8** by default (up from the original 5). Tune it with:

```toml
[tools]
max_tool_loop_iterations = 8   # optional; positive integer
```

Off by default and worth turning on only for high-tool-count servers — for a
server with a handful of tools, the search round-trip costs more than it saves.

## Deferred for later

Servers are admin-defined in `config.toml`, and the per-user auth that shipped
is a **static token** each user pastes in (see [Authentication](#authentication)
above). Still deferred: per-user **OAuth** — the 3-legged flow for Gmail /
Calendar / Drive servers, as opposed to the static token above — plus a
browser-side bridge for MCP servers running only on the user's laptop,
image/audio blocks in tool results, and argument-aware approval policies. All
live behind v1's seams; see the MCP entry in [`ROADMAP.md`](../ROADMAP.md) for
the phase-2 hook points.
