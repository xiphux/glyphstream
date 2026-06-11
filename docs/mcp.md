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

## Deferred for later

v1 is admin-defined with static auth only. Per-user OAuth (for Gmail /
Calendar / Drive MCP servers that need a user-bound token), a browser-side
bridge for MCP servers running only on the user's laptop, image/audio blocks
in tool results, and argument-aware approval policies all live behind v1's
seams — see the MCP entry in [`ROADMAP.md`](../ROADMAP.md) for the phase-2
hook points.
