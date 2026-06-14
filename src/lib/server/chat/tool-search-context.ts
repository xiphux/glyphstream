/**
 * Per-request tool-search context, shared by the two handlers that build an
 * upstream chat request — the message send (`/messages`) and the tool-approval
 * resume (`/tool-approval`). Both must advertise `search_tools` + inject the same
 * Tier-1 hint when the user/conversation has deferred tools, AND seed the
 * already-activated tools from the active branch — so a turn that searched up a
 * tool keeps it after an approval pause and across later turns. Centralizing the
 * logic here is the anti-drift measure (the `skills-context.ts` precedent).
 *
 * The hint is bounded by the number of deferred SERVERS, not their tool count:
 * it lists "<server> (<n> tools)" so the model knows what's searchable without
 * paying the per-tool token cost deferral is meant to avoid.
 */
import type { ChatMessage, FeatureCategory } from '$lib/types/api';
import type { OpenAIToolDefinition } from '../tools/types';
import { searchToolsDefinition } from '../tools/search-tools';
import { getMcpServerCfg, getUserServerStates, listServerCatalog } from '../mcp/registry';

export interface ToolSearchRequestContext {
	/** The `search_tools` definition to append to the tool list, or null. */
	def: OpenAIToolDefinition | null;
	/** The Tier-1 hint to append to the system prompt, or null. */
	hint: string | null;
}

const EMPTY: ToolSearchRequestContext = { def: null, hint: null };

interface DeferredGroup {
	displayName: string;
	count: number;
}

/**
 * Resolve `search_tools` advertisement + the Tier-1 hint for a request. Returns
 * the empty context (no tool, no hint) when no deferred tools exist for this
 * user/conversation — the omit-when-empty contract (mirrors
 * `buildSkillsRequestContext`). Async because per-user server state may lazily
 * connect.
 */
export async function buildToolSearchRequestContext(
	userId: string,
	disabledFeatures: readonly FeatureCategory[],
): Promise<ToolSearchRequestContext> {
	const excluded = new Set(disabledFeatures);
	const groups: DeferredGroup[] = [];

	// Global deferred servers (counts from the shared connection). listServerCatalog
	// returns every configured server, so filter to global here — per-user servers
	// are counted separately below (their tool count is per user).
	for (const entry of listServerCatalog()) {
		if (entry.auth !== 'global') continue;
		const cfg = getMcpServerCfg(entry.id);
		if (!cfg?.deferTools) continue;
		if (excluded.has(`mcp:${entry.id}`)) continue;
		if (entry.toolCount > 0)
			groups.push({ displayName: entry.displayName, count: entry.toolCount });
	}

	// Per-user deferred servers this user has connected.
	const states = await getUserServerStates(userId);
	for (const s of states) {
		if (s.auth !== 'per_user' || !s.configured || s.state !== 'connected') continue;
		const cfg = getMcpServerCfg(s.id);
		if (!cfg?.deferTools) continue;
		if (excluded.has(`mcp:${s.id}`)) continue;
		if (s.tools.length > 0) groups.push({ displayName: s.displayName, count: s.tools.length });
	}

	if (groups.length === 0) return EMPTY;
	return { def: searchToolsDefinition(), hint: composeHint(groups) };
}

function composeHint(groups: DeferredGroup[]): string {
	const list = groups
		.map((g) => `${g.displayName} (${g.count} tool${g.count === 1 ? '' : 's'})`)
		.join(', ');
	return (
		'Some tools are not loaded by default, to save space. Use the search_tools ' +
		"tool to find and load them when you need a capability you don't already have. " +
		`Available tool groups: ${list}.`
	);
}

/** Join a base system prompt with the tool-search hint, dropping nulls. */
export function appendToolSearchHint(base: string | null, hint: string | null): string | null {
	return [base, hint].filter(Boolean).join('\n\n') || null;
}

/** Drop duplicate tool definitions by function name (first wins). Guards the
 *  rare collision between the deferred-tool activation seed and the base
 *  advertisement — e.g. a tool activated on an earlier turn whose server's
 *  `defer_tools` flag has since been turned off, so it now appears in both. */
export function dedupeToolDefs(defs: OpenAIToolDefinition[]): OpenAIToolDefinition[] {
	const seen = new Set<string>();
	const out: OpenAIToolDefinition[] = [];
	for (const d of defs) {
		if (seen.has(d.function.name)) continue;
		seen.add(d.function.name);
		out.push(d);
	}
	return out;
}

/**
 * Union of every `activatedToolNames` persisted on a `search_tools` tool_result
 * part along the active branch. This is what makes deferred-tool loading
 * conversation-persistent: at turn start the handlers resolve these names back
 * into `tools[]` (via `resolveActivatedToolDefs`), so the model needn't re-search
 * each turn. Branch-scoped, so switching to a sibling branch only carries the
 * tools that branch activated.
 */
export function collectActivatedToolNames(branch: ChatMessage[]): string[] {
	const names = new Set<string>();
	for (const msg of branch) {
		for (const part of msg.parts) {
			if (part.type === 'tool_result' && part.activatedToolNames) {
				for (const n of part.activatedToolNames) names.add(n);
			}
		}
	}
	return [...names];
}
