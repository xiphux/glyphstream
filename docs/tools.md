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
  facts the model surfaces between sessions. Each memory also carries a short
  model-authored topic label.
- `search_conversations` — search the user's own past conversations (full
  message history across every thread) so the model can pull context it doesn't
  have in the current chat when the user refers back to something ("like we
  discussed", "the project I mentioned"). Runs the same owner-scoped full-text
  search as the sidebar, with an optional `time_range` recency filter; the current
  conversation is excluded. When the `[memory_model]` summary pass has run, each
  result also carries a short **gist** of the conversation and threads surface by
  meaning (the gist is indexed too), not only literal token overlap. Distinct from
  `recall_memory`, which reads the curated fact store — this searches raw history.
  Gated by the same **Personalization** toggle as the memory tools.
- `recall_memory` — read saved memories that aren't fully shown in the system
  prompt, by id or by search. Saved memories are normally inlined into the
  system prompt in full; once they grow past a size budget the store is split by
  a recency-decayed score — the highest-scored memories (recently or often
  recalled, or freshly saved) stay inlined in full up to the budget, and the
  rest are shown as a compact `[id] topic` index. The model reads an indexed
  entry's full body back through this tool — either by passing the ids of
  relevant-looking entries, or a search query. Recall-by-id needs no embedding
  model; a search query runs keyword (BM25) matching, additionally fused with
  semantic similarity when an embedding model is configured (the `[embeddings]`
  block; see [Web search & RAG](web-search.md)).

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
- **Personalization** is a _consumption_ gate — "don't tailor this response to
  me." It suppresses the prefs-derived persona (your Name / About you / Custom
  instructions) that would otherwise be injected as the system message, plus the
  injected memories and the conversation-topics overview, and it turns off the
  memory tools (`save_memory` / `update_memory` / `forget_memory` /
  `recall_memory`) and `search_conversations` — so this turn neither uses your
  stored context nor reads your past chats. It is **not** a content seal: a
  personalization-off conversation still _contributes_ to your searchable history
  and topic overview (which are only ever read by personalization-**on**
  conversations, so nothing surfaces anywhere you didn't consent to). The proper
  "keep this chat's content out of my cross-conversation stores" seal is a separate
  axis — [Private chat](#private-chat), below. Has no effect on conversations that
  carry an explicit system prompt or were started from a custom-model preset — those
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

## Private chat

The feature toggles above are a _consumption_ gate — they change what a given
turn is allowed to use. **Private chat** is the orthogonal _content seal_: it
keeps a conversation's content out of your cross-conversation stores entirely.
The two axes are deliberately separate — e.g. a roleplay/story chat may want
non-personalized output but still want its own sessions searchable for
continuity, while a private chat wants the opposite.

Turn it on from the incognito toggle in the upper-right of the **new-chat
screen**. It's fixed at creation and can't be flipped on an existing chat — a
private conversation is private for life, and a normal one can't be
retroactively sealed (its content may already be indexed). The whole app
re-tints to a violet "incognito" treatment and the sidebar marks the row, so
it's always obvious which mode you're in.

A private chat:

- **is never summarized** — so it produces no conversation summary, contributes
  nothing to your topic overview, and never becomes a `search_conversations`
  target;
- **is excluded from the `search_conversations` tool** even from other chats
  (its raw messages can't surface to the model elsewhere) — though it's still
  findable in your **own** sidebar full-text search, since the seal is about
  model/cross-conversation leakage, not hiding history from yourself;
- **runs with personalization, web, and every MCP server sealed off** for the
  turn (so no persona/memory/overview injection, no memory writes, no web or MCP
  egress), plus image/video **prompt enhancement** off — nothing leaves for any
  model but the chat's own. This is derived at request time, so it can't be
  re-enabled via the feature toggles — the feature menu shows those rows off and
  locked, leaving only code and skills toggleable;
- **keeps a local first-line title** instead of an auto-generated one. Titling
  sends the first exchange to your [`task_model`](configuration.md) — a secondary
  model unrelated to the chat's own — so a private chat is only auto-titled when
  you've marked that model trusted with `[task_model] private = true` (set it only
  if the task model runs somewhere you trust with private content, e.g. a local
  llama.cpp).

Left **on** by design: the **code interpreter** (runs in a sandboxed server-side
worker with an ephemeral per-conversation filesystem — nothing is kept or sent
out, and its only network egress is already sealed by the web disable) and **agent
skills** (static context pulled _in_, nothing sent out).

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
