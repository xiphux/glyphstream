import type { Tool, ToolExecution } from '../tools/types';
import { register } from '../tools/registry';
import { callMcpTool, getMcpServerCfg, getMcpServerTools, listMcpServerStates } from './registry';
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
export function mcpToolFor(server: LoadedMcpServer, mcpTool: McpToolDescriptor): Tool {
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
		},
		async execute(args, ctx): Promise<ToolExecution> {
			try {
				const result = await callMcpTool(server.id, mcpTool.name, args, ctx.signal);
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
	for (const state of listMcpServerStates()) {
		if (state.state === 'failed') continue;
		registerMcpServerTools(state.id);
	}
}

/**
 * Register the currently-advertised tools for a single server. Used by
 * the manual-reconnect path so a server that came up after boot can be
 * surfaced to the LLM without restarting the process.
 */
export function registerMcpServerTools(serverId: string): void {
	const cfg = getMcpServerCfg(serverId);
	if (!cfg) return;
	for (const t of getMcpServerTools(serverId)) register(mcpToolFor(cfg, t));
}
