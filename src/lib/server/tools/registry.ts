/**
 * Process-singleton tool registry. Built-in tools register themselves on
 * module import (via `./index.ts`'s side-effect imports); future MCP
 * tools will call `register()` at runtime once their server connection
 * is established. `get()` is how the loop looks a tool up by the name
 * the model emitted in a tool_call.
 */

import type { OpenAIToolDefinition, Tool } from './types';

const tools = new Map<string, Tool>();

/** Register a tool. Re-registering the same name replaces the entry —
 *  this is the desired behavior under Vite HMR (the dev server re-
 *  evaluates the tools module and re-runs each `register()`; throwing
 *  would force a full restart on every edit). MCP tools register via
 *  the same path at startup; they don't re-register at runtime in v1,
 *  so the replace semantics are only exercised in dev mode HMR. The
 *  registry stays globally unique by construction — Map key collision
 *  means latest-wins, not coexistence. */
export function register(tool: Tool): void {
	const name = tool.definition.function.name;
	tools.set(name, tool);
}

/** Look up a tool by the name the model emitted, or undefined if unknown
 *  (the loop should treat unknown calls as tool errors fed back to the
 *  model, not crashes). */
export function get(name: string): Tool | undefined {
	return tools.get(name);
}

/** All registered tools, in insertion order. */
export function list(): Tool[] {
	return Array.from(tools.values());
}

/** OpenAI tools[] array shape — what we splice into the upstream request
 *  body when the endpoint supports tools. Two filter layers are applied:
 *
 *  - `isAvailable()` drops tools whose backing config (SearxNG URL, MCP
 *    connection, ...) isn't present in this deployment.
 *  - `excludeCategories` drops tools whose `metadata.category` is in the
 *    list — the per-conversation opt-out path. See FEATURE_CATEGORIES
 *    in `$lib/types/api`.
 *
 *  Tools that omit either signal default to always-on. Returns an empty
 *  array when nothing remains (callers should treat that as "omit tools
 *  from the request entirely" rather than send `tools: []`). */
export function openaiToolDefinitions(opts?: {
	excludeCategories?: readonly string[];
}): OpenAIToolDefinition[] {
	const exclude = opts?.excludeCategories?.length ? new Set(opts.excludeCategories) : null;
	return list()
		.filter((t) => t.isAvailable?.() ?? true)
		.filter((t) => !exclude || !t.metadata?.category || !exclude.has(t.metadata.category))
		.map((t) => t.definition);
}

/** Test-only: wipe the registry. Production code never calls this. */
export function _resetForTests(): void {
	tools.clear();
}
