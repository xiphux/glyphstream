# Tool calling

GlyphStream supports native OpenAI tool calling — the model decides when to
invoke a registered tool, GlyphStream runs it server-side, and the result is
folded back into the conversation. The built-in toolset:

- `get_current_time` — clock with optional IANA timezone.
- `fetch_url` — read a single web page or text resource by URL. Takes an
  optional `find` so long pages return the most relevant sections rather
  than the first 20 KB (see [Web search & RAG](web-search.md)).
- `web_search` — query a [SearxNG](https://docs.searxng.org/) instance
  (requires a `[search]` config block; see [Web search & RAG](web-search.md)).
- `run_python` — execute Python in a sandboxed Pyodide interpreter, with
  file round-trip to the conversation's attachments (see
  [Code interpreter](code-interpreter.md)).
- `save_memory` / `update_memory` / `forget_memory` — persist user-scoped
  facts the model surfaces between sessions.

The architecture is unbounded — adding more is a single file under
`src/lib/server/tools/` (see [Adding more tools](#adding-more-tools)), and
external [MCP servers](mcp.md) plug their toolsets into the same registry
with zero code.

## Enable per endpoint

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

The flag is **endpoint-scoped** as a fallback. If the upstream advertises
tool support per model (the openai-api-bridge does this for the OpenRouter
backend, reading the `supported_parameters` field from OpenRouter's
catalog), GlyphStream prefers that per-model signal and the endpoint flag is
a default for models that don't self-report. Defaults to `false` for
safety — endpoints stay tool-disabled until you opt them in.

## Model requirements

Tool calling **only works with models trained for it**. Even with the config
flag set, a model that wasn't fine-tuned for tool use will either ignore the
`tools` array or emit malformed `tool_calls`. As of this writing, known-good
local options include:

- Llama 3.1, 3.2, 3.3 Instruct (8B+)
- Qwen 2.5, 3 Instruct (7B+)
- Gemma 3 (12B+)
- Hermes-3
- Most Mistral instruct fine-tunes

Smaller / older models (Llama 2, anything ≤3B) typically flail.

## llama.cpp setup

`llama-server` supports OpenAI-shape tool calling out of the box. The
model's chat template (loaded via Jinja) is what surfaces tools to the
model, and Jinja templating is **on by default** in current `llama-server`
builds — you only need to act if you've explicitly turned it off. If you've
set `--no-jinja`, the `tools` array gets silently dropped before the model
ever sees it; drop the flag and tools work.

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

(`max_concurrent` serializes requests against a single-GPU backend — see
[the configuration guide](configuration.md#limiting-concurrency-max_concurrent).)

## Per-conversation feature toggles

The composer surfaces a small popover (the sliders icon next to the attach
button) with one switch per opt-out _category_:

- **Web access** disables both `web_search` and `fetch_url` together, so the
  model can't compose around partial gating by `fetch_url`-ing a
  search-engine URL directly. The two web-touching tools share a `web`
  category and the single switch closes the whole egress path.
- **Personalization** suppresses the prefs-derived persona (your Name /
  About you / Custom instructions) that would otherwise be injected as the
  system message AND turns off the memory tools (`save_memory` /
  `update_memory` / `forget_memory`) so a privacy-sensitive turn can't grow
  the saved memory store. Has no effect on conversations that carry an
  explicit system prompt or were started from a custom-model preset — those
  already snapshot whatever prompt _they_ declared.
- **Code interpreter** disables `run_python` for the turn. The web toggle
  above still independently controls Python's network egress (so a
  code-allowed but web-blocked turn runs pure compute with no outbound
  traffic, including `micropip`).
- **One toggle per configured MCP server** (`mcp:<server-id>`, labeled with
  the server's `display_name`). Closes off every tool that server advertises
  in one switch — the natural unit of trust for a multi-tool MCP server. See
  [MCP servers](mcp.md) for the broader trust model.

Why category-level rather than one switch per tool: an opt-out motivated by
privacy is a security boundary, not a UX grouping. The `web` category
bundling described above is the same instinct behind keeping
`personalization` broad (persona + memory together) and behind bundling
every MCP-server tool under one toggle — a single switch seals every avenue
along that axis instead of asking the user to remember which sub-tools
matter.

Defaults are **all features on** for every new conversation — never sticky
across sessions, since a one-time off-flip carrying forward silently would
undermine the privacy intent. Toggles flipped in an existing chat apply
forward from the next message; history already on the page is unaffected.

## Adding more tools

Each tool is a TypeScript module under `src/lib/server/tools/` that exports
an OpenAI tool definition + an `execute(args, ctx)` function, registered via
`register(...)` at module load. The
[`get_current_time` implementation](../src/lib/server/tools/clock.ts) is the
smallest end-to-end example; copy its shape, add an import line in
`src/lib/server/tools/index.ts`, and the new tool is live for every endpoint
with `supports_tools = true`. Tools backed by optional config (like
`web_search` is by `[search]`) can implement `isAvailable()` to hide
themselves when their backend isn't present. Tools that should be reachable
from the per-conversation opt-out panel declare a `category` in their
`metadata` (see `BUILTIN_FEATURE_CATEGORIES` in `$lib/types/api`).

For one-off custom logic, an in-tree tool is the right level. If the
capability you want is generic enough that other people would also want
it — or if it already exists as a published MCP server — point GlyphStream
at the MCP server in `config.toml` instead (see [MCP servers](mcp.md)). No
code changes needed; the runtime registry picks it up at boot.
