/**
 * Tool registry types. The Tool interface is the contract every registered
 * tool implements — built-in tools (clock, future web_search, etc.) and,
 * later, MCP-discovered tools that proxy to remote servers.
 *
 * `definition` is what we send upstream to the model (straight OpenAI
 * tools[] shape). `execute` is what we run when the model calls it.
 * `metadata` is UI-only and never crosses the wire.
 */

/** OpenAI tools[] entry. See https://platform.openai.com/docs/api-reference/chat/create#chat-create-tools */
export interface OpenAIToolDefinition {
	type: 'function';
	function: {
		name: string;
		description: string;
		/** JSON Schema describing the function's parameters. */
		parameters: Record<string, unknown>;
	};
}

/**
 * Per-call context passed to `execute`. Carries identity (so tools can
 * scope to the user / conversation) and an AbortSignal so long-running
 * tools cooperate with turn cancellation.
 */
export interface ToolContext {
	userId: string;
	conversationId: string;
	signal: AbortSignal;
	/**
	 * Per-conversation feature-category opt-outs (`disabled_features`).
	 * Most built-ins ignore this — registry-level filtering at request
	 * build time (via `openaiToolDefinitions({ excludeCategories })`)
	 * is enough when the tool's ENTIRE existence is gated by the
	 * category. Tools whose BEHAVIOR depends on a sibling category —
	 * notably `run_python`, whose Python network shim must refuse
	 * egress when `'web'` is disabled even though `run_python` itself
	 * lives in `'code_interpreter'` — read it here. Always an array
	 * (possibly empty), never undefined.
	 */
	disabledFeatures: readonly import('$lib/types/api').FeatureCategory[];
}

/**
 * The result of a tool invocation. `content` is sent back to the model
 * as the `tool` message body — must be a string per OpenAI spec; tools
 * returning structured data should JSON.stringify it themselves.
 *
 * `isError: true` is fed back to the model (it can apologize / retry)
 * rather than aborting the turn. The UI flags it visually so users see
 * which calls failed.
 */
export interface ToolExecution {
	content: string;
	isError?: boolean;
	/**
	 * Media ids the executor created during this call (e.g. files
	 * Python wrote under /workspace/). The streaming-relay's
	 * tool-execution path picks these up after persisting the tool-
	 * result message and calls `linkMessageMedia(toolMsg.id, id)`
	 * for each, symmetric with how user uploads attach to user
	 * messages via the wire-level `attachedMediaIds`. Tools that
	 * don't generate media omit this field.
	 */
	attachedMediaIds?: string[];
	/**
	 * Tool names this call made callable for the rest of the turn (and,
	 * once persisted, the rest of the conversation). `search_tools` returns
	 * its matches here: the streaming relay accumulates them into a per-turn
	 * set and re-includes their full definitions in the next iteration's
	 * `tools[]`, and `executeToolCalls` persists them onto the tool_result
	 * part so a later turn's branch scan can re-load them. Mirrors
	 * `attachedMediaIds` — the tool signals data back to the relay via its
	 * return value, not a side channel. Tools that don't surface tools omit
	 * this field.
	 */
	activatedToolNames?: string[];
	/**
	 * Set by the canvas tools (`create_canvas` / `update_canvas`) after they
	 * apply and persist an edit. The tool-execution stage emits it as a
	 * `canvas_version` StreamEvent so the side-by-side pane updates live. Purely
	 * a live-tick signal — the pane rehydrates from the DB on reload, so this is
	 * never the durable record. Omitted by every non-canvas tool.
	 */
	canvas?: import('$lib/types/api').CanvasVersion;
}

/**
 * Optional UI-only metadata. Never sent upstream. `displayLabel` is a
 * future hook for showing "Clock" alongside `get_current_time` if the
 * raw function name proves too cryptic for some tools — v1 renders the
 * raw name only.
 *
 * `category` groups tools for per-conversation opt-out (see
 * FEATURE_CATEGORIES in `$lib/types/api`). Tools sharing a category are
 * gated together by a single switch — e.g. `web_search` and `fetch_url`
 * both declare 'web' so disabling "Web access" closes the entire egress
 * path, not just one tool. Tools that omit a category are always on
 * (clock).
 */
export interface ToolMetadata {
	displayLabel?: string;
	icon?: string;
	category?: import('$lib/types/api').FeatureCategory;
	/**
	 * Hidden from the default tool advertisement (`openaiToolDefinitions()` /
	 * `buildUserMcpToolDefinitions()` drop it), discoverable only via the
	 * `search_tools` built-in, which surfaces the full definition per-request
	 * once a query matches. The MCP bridge sets this for servers configured
	 * `defer_tools = true` so a high-tool-count server (e.g. GitHub MCP)
	 * doesn't burn context on every request. The registry entry still exists
	 * so `get(name)` resolves it for EXECUTION and so `deferredToolCatalog()`
	 * can enumerate it for search. Always-on tools omit this field.
	 */
	deferred?: boolean;
}

/**
 * One entry in the searchable catalog of deferred tools. Carries just the
 * fields the `search_tools` hybrid ranker scores over (name + description) plus
 * the `mcp:<id>` category, so the catalog can be re-filtered by a conversation's
 * per-feature opt-outs at search time. The full definition lives on the registry
 * entry, resolved by name via `resolveActivatedToolDefs()` once a tool is picked.
 */
export interface DeferredToolEntry {
	name: string;
	description: string;
	category?: import('$lib/types/api').FeatureCategory;
	/**
	 * The tool's bare (un-namespaced) name — `metadata.displayLabel`, e.g.
	 * `list_undone_tasks_by_time_query` for `mcp__ticktick__list_undone_…`. Used
	 * by the turn-start hint to list a server's tools by their short names (the
	 * Tier-1 discovery list), so the model can see the full catalog without
	 * paying for schemas. Falls back to `name` when no label was set.
	 */
	displayLabel?: string;
}

export interface Tool {
	definition: OpenAIToolDefinition;
	metadata?: ToolMetadata;
	/**
	 * Optional availability predicate. When omitted, the tool is always
	 * advertised. When present and returns false, the tool is filtered out
	 * of `openaiToolDefinitions()` so the model never sees it as callable
	 * (used by tools whose backing config — SearxNG instance URL, MCP
	 * server connection, etc. — may not be present in every deployment).
	 * Called once per request that consults the registry; cheap.
	 */
	isAvailable?(): boolean;
	/**
	 * Maximum wall-clock for a single execute() call. Past this the tool
	 * gets an abort signal and the call resolves as an error result so
	 * the rest of the turn's tool_calls and the next iteration can
	 * proceed without waiting on a hung tool. Omit to use the default
	 * (DEFAULT_TOOL_TIMEOUT_MS in tool-execution.ts).
	 */
	timeoutMs?: number;
	execute(args: unknown, ctx: ToolContext): Promise<ToolExecution> | ToolExecution;
}
