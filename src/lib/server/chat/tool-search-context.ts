/**
 * Per-request tool-search context, shared by the two handlers that build an
 * upstream chat request — the message send (`/messages`) and the tool-approval
 * resume (`/tool-approval`). Both must advertise `search_tools` + inject the same
 * Tier-1 hint when the user/conversation has deferred tools, AND seed the
 * already-activated tools from the active branch — so a turn that searched up a
 * tool keeps it after an approval pause and across later turns. Centralizing the
 * logic here is the anti-drift measure (the `skills-context.ts` precedent).
 *
 * The hint lists every deferred tool by its short NAME, grouped under its server
 * (no descriptions, no schemas) — the Tier-1 discovery list. Names are cheap
 * (~5% of the schema cost they replace) but make the catalog fully visible, so
 * the model never searches blind: it can see a capability exists and copy the
 * name straight into `search_tools` to load the schema. This mirrors how Claude
 * Code surfaces its own deferred tools — names always in context, schemas loaded
 * on demand — and it's why there's no server-size threshold (a count gate would
 * leave the largest, most-needed catalogs blind, the exact opposite of useful).
 */
import type { ChatMessage, FeatureCategory } from '$lib/types/api';
import type { DeferredToolEntry, OpenAIToolDefinition } from '../tools/types';
import { searchToolsDefinition } from '../tools/search-tools';
import { deferredToolCatalog } from '../tools/registry';
import { buildUserDeferredToolCatalog } from '../mcp/tool-bridge';
import { getMcpServerCfg, type UserServerState } from '../mcp/registry';

export interface ToolSearchRequestContext {
	/** The `search_tools` definition to append to the tool list, or null. */
	def: OpenAIToolDefinition | null;
	/** The Tier-1 hint to append to the system prompt, or null. */
	hint: string | null;
}

const EMPTY: ToolSearchRequestContext = { def: null, hint: null };

interface DeferredGroup {
	displayName: string;
	toolNames: string[];
}

/**
 * Resolve `search_tools` advertisement + the Tier-1 hint for a request. Returns
 * the empty context (no tool, no hint) when no deferred tools exist for this
 * user/conversation — the omit-when-empty contract (mirrors
 * `buildSkillsRequestContext`). Async because per-user server state may lazily
 * connect.
 *
 * Built from the SAME catalog `search_tools` searches over (global
 * `deferredToolCatalog` ∪ this user's `buildUserDeferredToolCatalog`), so the
 * advertised tool list and the searchable set can't drift apart, and both honor
 * the conversation's `excludeCategories` opt-out identically.
 */
export async function buildToolSearchRequestContext(
	userId: string,
	disabledFeatures: readonly FeatureCategory[],
	states?: UserServerState[],
): Promise<ToolSearchRequestContext> {
	const catalog: DeferredToolEntry[] = [
		...deferredToolCatalog({ excludeCategories: disabledFeatures }),
		...(await buildUserDeferredToolCatalog(userId, {
			excludeCategories: disabledFeatures,
			states,
		})),
	];
	if (catalog.length === 0) return EMPTY;
	return { def: searchToolsDefinition(), hint: composeHint(groupByServer(catalog)) };
}

/**
 * Group deferred catalog entries by their `mcp:<id>` category into per-server
 * lists of short tool names, preserving first-seen order (global servers first,
 * then per-user). The server's human display name comes from its config; the
 * category id is the fallback.
 */
function groupByServer(catalog: DeferredToolEntry[]): DeferredGroup[] {
	const byCategory = new Map<string, DeferredGroup>();
	for (const entry of catalog) {
		const category = entry.category ?? 'mcp:unknown';
		let group = byCategory.get(category);
		if (!group) {
			const id = category.startsWith('mcp:') ? category.slice('mcp:'.length) : category;
			group = { displayName: getMcpServerCfg(id)?.displayName ?? id, toolNames: [] };
			byCategory.set(category, group);
		}
		group.toolNames.push(entry.displayLabel ?? entry.name);
	}
	return [...byCategory.values()];
}

function composeHint(groups: DeferredGroup[]): string {
	const list = groups.map((g) => `${g.displayName}: ${g.toolNames.join(', ')}`).join('\n');
	return (
		'Some tools are not loaded by default, to save context. To use one, call the ' +
		'search_tools tool with a short query (the tool name from the list below works) ' +
		'to load its schema, then call it. The available tools are:\n' +
		list
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
