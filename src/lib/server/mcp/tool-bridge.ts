import type { DeferredToolEntry, OpenAIToolDefinition, Tool, ToolExecution } from '../tools/types';
import { register } from '../tools/registry';
import {
	callMcpTool,
	getMcpServerCfg,
	getMcpServerTools,
	getUserServerStates,
	listGlobalServerIds,
} from './registry';
import type { McpCallResult, McpContentBlock, McpToolDescriptor } from './client';
import type { LoadedMcpServer } from './config';

/** The OpenAI tool-name spec: 1-64 chars, [a-zA-Z0-9_-]. */
const MAX_TOOL_NAME_LEN = 64;
const NAMESPACE_PREFIX = 'mcp__';

/**
 * Map an MCP tool advertisement to the registered name we'll emit upstream.
 * Namespacing collapses cross-server collisions and prefix-matches make it
 * easy for the relay-loop to identify MCP tools without a lookup
 * (`name.startsWith('mcp__')`).
 *
 * Server IDs are already constrained to alphanumeric+dash by the config
 * validator. Upstream MCP tool names occasionally contain characters
 * outside the OpenAI spec; we sanitize to `_` and truncate the tool-name
 * suffix if the combined string overruns 64 chars.
 */
export function buildRegisteredName(serverId: string, toolName: string): string {
	const sanitized = toolName.replace(/[^a-zA-Z0-9_-]/g, '_');
	const prefix = `${NAMESPACE_PREFIX}${serverId}__`;
	const budget = MAX_TOOL_NAME_LEN - prefix.length;
	if (budget < 1) {
		// Pathological server id, shouldn't happen given config-validator
		// limits — but degrade safely rather than throwing during boot.
		return prefix.slice(0, MAX_TOOL_NAME_LEN);
	}
	const suffix = sanitized.length > budget ? sanitized.slice(0, budget) : sanitized;
	return `${prefix}${suffix}`;
}

/**
 * Wrap an MCP-discovered tool as a Tool registry entry. Tool execution
 * proxies through `callMcpTool` so the registry's reconnect / idle-reap
 * logic stays in one place.
 */
export function mcpToolFor(
	server: LoadedMcpServer,
	mcpTool: McpToolDescriptor,
	opts: { perUser?: boolean } = {},
): Tool {
	const registeredName = buildRegisteredName(server.id, mcpTool.name);
	const categoryName = `mcp:${server.id}`;
	const description = mcpTool.description?.trim()
		? mcpTool.description.trim()
		: `Tool provided by the "${server.displayName}" MCP server.`;

	return {
		definition: {
			type: 'function',
			function: {
				name: registeredName,
				description,
				parameters: normalizeParameters(mcpTool.inputSchema),
			},
		},
		metadata: {
			displayLabel: mcpTool.name,
			category: categoryName,
			// Servers flagged `defer_tools` are hidden from the default
			// advertisement and surfaced only via `search_tools`. Global deferred
			// tools stay resolvable + enumerable (no isAvailable override below);
			// per-user deferred tools are additionally `isAvailable:false`.
			...(server.deferTools ? { deferred: true } : {}),
		},
		// Per-user tools are never advertised via the static registry
		// (`isAvailable: false`) — availability is per-user, so the message /
		// tool-approval handlers append the definition per request for users
		// who've configured the server. The registry entry still exists so the
		// relay's `registry.get(name)` resolves it for EXECUTION, where
		// `ctx.userId` selects the caller's connection. Global tools omit the
		// predicate and stay always-on.
		...(opts.perUser ? { isAvailable: () => false } : {}),
		async execute(args, ctx): Promise<ToolExecution> {
			try {
				// ctx.userId scopes per-user servers to the caller's own
				// connection/credential; it's ignored for global servers.
				const result = await callMcpTool(server.id, ctx.userId, mcpTool.name, args, ctx.signal);
				return flattenMcpResult(result);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return { content: JSON.stringify({ error: message }), isError: true };
			}
		},
	};
}

/**
 * Flatten an MCP CallToolResult into a single string for the model. v1
 * concatenates text blocks; non-text blocks (image, audio, resource) are
 * replaced with a single placeholder line so the model still sees that
 * non-text content was returned even when it can't read it. Once the
 * upstream supports vision/audio in tool results, this is the choke
 * point.
 */
export function flattenMcpResult(result: McpCallResult): ToolExecution {
	const parts: string[] = [];
	let droppedNonText = false;
	for (const block of result.content) {
		if (isTextBlock(block)) {
			parts.push(block.text);
		} else {
			droppedNonText = true;
		}
	}
	if (droppedNonText) parts.push('[non-text content omitted in v1]');
	const content = parts.length > 0 ? parts.join('\n') : '';
	return { content, isError: result.isError };
}

function isTextBlock(block: McpContentBlock): block is { type: 'text'; text: string } {
	return block.type === 'text' && typeof (block as { text?: unknown }).text === 'string';
}

/**
 * Force an `inputSchema` payload into a JSON Schema object the model will
 * accept. MCP servers occasionally advertise tools with no input schema
 * (or a primitive-shaped one); the upstream tool-calling format expects
 * `parameters.type === 'object'`.
 */
function normalizeParameters(schema: unknown): Record<string, unknown> {
	if (schema && typeof schema === 'object' && !Array.isArray(schema)) {
		const s = schema as Record<string, unknown>;
		if (s.type === 'object') return s;
	}
	return { type: 'object', properties: {}, additionalProperties: true };
}

/**
 * Register one Tool entry per discovered MCP tool. The tool registry's
 * `register()` is replace-semantics, so re-running this after a
 * post-boot reconnect is safe.
 */
export function registerAllMcpTools(): void {
	for (const serverId of listGlobalServerIds()) registerMcpServerTools(serverId);
}

/**
 * Register the currently-advertised tools for a single GLOBAL server. Used by
 * the manual-reconnect path so a server that came up after boot can be
 * surfaced to the LLM without restarting the process. (Per-user servers go
 * through `registerPerUserServerTools` — their availability is per request.)
 */
export function registerMcpServerTools(serverId: string): void {
	const cfg = getMcpServerCfg(serverId);
	if (!cfg) return;
	for (const t of getMcpServerTools(serverId)) register(mcpToolFor(cfg, t));
}

/**
 * Register a per-user server's discovered tools so the relay's
 * `registry.get(name)` can resolve them for EXECUTION. They register with
 * `isAvailable: false` (never in the static advertisement); the request
 * handlers append their definitions per request for users who've configured
 * the server. Idempotent (registry is replace-semantics), so calling it each
 * time a user's connection reports tools is fine.
 */
export function registerPerUserServerTools(
	server: LoadedMcpServer,
	tools: McpToolDescriptor[],
): void {
	for (const t of tools) register(mcpToolFor(server, t, { perUser: true }));
}

/**
 * Build the per-request tool definitions for the caller's per-user MCP
 * servers — the dynamic counterpart of the static `openaiToolDefinitions()`
 * (which omits per-user tools via `isAvailable: false`). For each per-user
 * server the user has connected, this also (re)registers its tools so the
 * relay's `registry.get(name)` resolves them for execution. `excludeCategories`
 * applies the same per-conversation opt-out the static path uses (the
 * server's `mcp:<id>` category).
 *
 * Async because resolving a user's servers may lazily connect them. Append
 * the result to the static `openaiToolDefinitions()` output in the message /
 * tool-approval handlers.
 */
export async function buildUserMcpToolDefinitions(
	userId: string,
	opts: { excludeCategories?: readonly string[] } = {},
): Promise<OpenAIToolDefinition[]> {
	const exclude = opts.excludeCategories?.length ? new Set(opts.excludeCategories) : null;
	const states = await getUserServerStates(userId);
	const defs: OpenAIToolDefinition[] = [];
	for (const s of states) {
		if (s.auth !== 'per_user' || !s.configured || s.state !== 'connected') continue;
		if (exclude?.has(`mcp:${s.id}`)) continue;
		const cfg = getMcpServerCfg(s.id);
		if (!cfg) continue;
		for (const t of s.tools) {
			const tool = mcpToolFor(cfg, t, { perUser: true });
			register(tool); // ensure execution can resolve it via registry.get(name)
			// Deferred per-user tools are registered (so execution + a later
			// activation can resolve them) but NOT advertised — they surface via
			// search_tools / buildUserDeferredToolCatalog instead.
			if (!cfg.deferTools) defs.push(tool.definition);
		}
	}
	return defs;
}

/**
 * Build the searchable catalog of the caller's connected PER-USER deferred
 * tools — the per-user counterpart of the static `deferredToolCatalog()` (which
 * only sees global deferred tools, since per-user tools carry
 * `isAvailable:false`). Registers each tool as a side effect (so the relay's
 * `resolveActivatedToolDefs` / `registry.get(name)` can resolve it for
 * activation + execution), mirroring `buildUserMcpToolDefinitions`. Honors the
 * same per-conversation `excludeCategories` opt-out.
 *
 * Append the result to the global `deferredToolCatalog()` output when building
 * the catalog `search_tools` searches over.
 */
export async function buildUserDeferredToolCatalog(
	userId: string,
	opts: { excludeCategories?: readonly string[] } = {},
): Promise<DeferredToolEntry[]> {
	const exclude = opts.excludeCategories?.length ? new Set(opts.excludeCategories) : null;
	const states = await getUserServerStates(userId);
	const entries: DeferredToolEntry[] = [];
	for (const s of states) {
		if (s.auth !== 'per_user' || !s.configured || s.state !== 'connected') continue;
		const cfg = getMcpServerCfg(s.id);
		if (!cfg || !cfg.deferTools) continue;
		if (exclude?.has(`mcp:${s.id}`)) continue;
		for (const t of s.tools) {
			const tool = mcpToolFor(cfg, t, { perUser: true });
			register(tool); // resolvable for activation + execution
			entries.push({
				name: tool.definition.function.name,
				description: tool.definition.function.description,
				category: tool.metadata?.category,
				displayLabel: tool.metadata?.displayLabel,
			});
		}
	}
	return entries;
}
