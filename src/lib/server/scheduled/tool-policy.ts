/**
 * A scheduled task's tool policy (`ScheduledToolPolicy`): parsing, and the
 * per-tool decision the run's tool context makes from it.
 */
import type { ScheduledToolPolicy } from '#lib/types/api.js';

/** Caps a policy list at a size no real MCP fleet reaches, so a request body
 *  can't make every run's policy check walk a million names. */
export const MAX_POLICY_TOOLS = 500;
const MAX_TOOL_NAME_CHARS = 128;

export const EMPTY_TOOL_POLICY: ScheduledToolPolicy = { allowed: [], ask: [], memoryWrites: false };

function names(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const out = new Set<string>();
	for (const n of input) {
		if (typeof n === 'string' && n.length > 0 && n.length <= MAX_TOOL_NAME_CHARS) out.add(n);
		if (out.size >= MAX_POLICY_TOOLS) break;
	}
	return [...out].sort();
}

/**
 * Coerce an untrusted policy (a request body, a stored row) into a valid one.
 * Lenient by design — junk entries are dropped rather than rejected — because
 * every outcome is safe: a tool that falls out of both lists is simply not
 * offered. A name in both lists is `ask`, the more cautious reading.
 */
export function coerceToolPolicy(input: unknown): ScheduledToolPolicy {
	if (!input || typeof input !== 'object') return EMPTY_TOOL_POLICY;
	const p = input as Record<string, unknown>;
	const ask = names(p.ask);
	const askSet = new Set(ask);
	return {
		allowed: names(p.allowed).filter((n) => !askSet.has(n)),
		ask,
		memoryWrites: p.memoryWrites === true,
	};
}

export function parseToolPolicy(raw: string | null): ScheduledToolPolicy {
	if (!raw) return EMPTY_TOOL_POLICY;
	try {
		return coerceToolPolicy(JSON.parse(raw));
	} catch {
		return EMPTY_TOOL_POLICY;
	}
}

/** The built-in tools that write the user's memory store. Reading it
 *  (`recall_memory`, and the memories in the persona prompt) is unaffected. */
export const MEMORY_WRITE_TOOLS: ReadonlySet<string> = new Set([
	'save_memory',
	'update_memory',
	'forget_memory',
]);

/**
 * Which tools a run under `policy` may use at all. MCP tools must be named in
 * the policy; memory writes need `memoryWrites`; every other built-in is left
 * to the run's disabled categories, as in a chat.
 */
export function toolPermitter(policy: ScheduledToolPolicy): (toolName: string) => boolean {
	const offered = new Set([...policy.allowed, ...policy.ask]);
	return (toolName) => {
		if (toolName.startsWith('mcp__')) return offered.has(toolName);
		if (MEMORY_WRITE_TOOLS.has(toolName)) return policy.memoryWrites;
		return true;
	};
}

/** The approval gate for a run: the policy's `ask` list, nothing else. The
 *  user's global trust list doesn't apply — the schedule says what it trusts. */
export function policyNeedsApproval(policy: ScheduledToolPolicy): (toolName: string) => boolean {
	const ask = new Set(policy.ask);
	return (toolName) => ask.has(toolName);
}
