/**
 * Process-singleton tool registry. Built-in tools register themselves on
 * module import (via `./index.ts`'s side-effect imports); future MCP
 * tools will call `register()` at runtime once their server connection
 * is established. `get()` is how the loop looks a tool up by the name
 * the model emitted in a tool_call.
 */

import type { DeferredToolEntry, OpenAIToolDefinition, Tool } from './types';

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
 *  from the request entirely" rather than send `tools: []`).
 *
 *  A third filter drops `metadata.deferred` tools: those are hidden from the
 *  default advertisement and surfaced only via `search_tools` (which enumerates
 *  them through `deferredToolCatalog()` and loads the chosen ones back via
 *  `resolveActivatedToolDefs()`). */
export function openaiToolDefinitions(opts?: {
	excludeCategories?: readonly string[];
}): OpenAIToolDefinition[] {
	const exclude = opts?.excludeCategories?.length ? new Set(opts.excludeCategories) : null;
	return list()
		.filter((t) => !t.metadata?.deferred)
		.filter((t) => t.isAvailable?.() ?? true)
		.filter((t) => !exclude || !t.metadata?.category || !exclude.has(t.metadata.category))
		.map((t) => t.definition);
}

/** The searchable catalog of GLOBAL deferred tools, for `search_tools`. Same
 *  two filter layers as the advertisement (`isAvailable()` + `excludeCategories`)
 *  but inverted on `deferred`: only deferred tools are returned. Per-user
 *  deferred tools carry `isAvailable:false`, so they're excluded here and
 *  enumerated separately by `buildUserDeferredToolCatalog()` — symmetric with
 *  how `buildUserMcpToolDefinitions()` complements `openaiToolDefinitions()`. */
export function deferredToolCatalog(opts?: {
	excludeCategories?: readonly string[];
}): DeferredToolEntry[] {
	const exclude = opts?.excludeCategories?.length ? new Set(opts.excludeCategories) : null;
	return list()
		.filter((t) => t.metadata?.deferred)
		.filter((t) => t.isAvailable?.() ?? true)
		.filter((t) => !exclude || !t.metadata?.category || !exclude.has(t.metadata.category))
		.map((t) => ({
			name: t.definition.function.name,
			description: t.definition.function.description,
			category: t.metadata?.category,
		}));
}

/** Resolve activated (searched-up) tool names to their full definitions, for
 *  splicing into `tools[]` — used by both the turn-start branch-scan seed and
 *  the relay's per-iteration rebuild. Deduplicates, skips names that no longer
 *  resolve (server removed since the tool was activated), and honors the
 *  `excludeCategories` opt-out (the security boundary — a conversation that
 *  disabled `mcp:<id>` must not re-load that server's tools even if a past turn
 *  loaded them). Deliberately does NOT apply `isAvailable()`: per-user deferred
 *  tools report `isAvailable:false` by design and are loaded on demand. */
export function resolveActivatedToolDefs(
	names: Iterable<string>,
	opts?: { excludeCategories?: readonly string[] },
): OpenAIToolDefinition[] {
	const exclude = opts?.excludeCategories?.length ? new Set(opts.excludeCategories) : null;
	const defs: OpenAIToolDefinition[] = [];
	const seen = new Set<string>();
	for (const name of names) {
		if (seen.has(name)) continue;
		seen.add(name);
		const tool = tools.get(name);
		if (!tool) continue;
		if (exclude && tool.metadata?.category && exclude.has(tool.metadata.category)) continue;
		defs.push(tool.definition);
	}
	return defs;
}

/** Test-only: wipe the registry. Production code never calls this. */
export function _resetForTests(): void {
	tools.clear();
}
