import { error } from '@sveltejs/kit';
import { getUserPreferences } from '$lib/server/db/queries/user-preferences';
import { awaitMcpReady } from '$lib/server/mcp/bootstrap';
import { listMcpServerStates } from '$lib/server/mcp/registry';
import type { PageServerLoad } from './$types';

/**
 * Server load for the cross-cutting permissions surface. Currently
 * lists trusted MCP tools (the "always allow" grants). Future grants
 * (skill scripts, Open Terminal commands) plug into the same data
 * shape.
 *
 * Tools group by their backing server so users can scan related
 * entries together. Trust grants whose server is no longer in
 * config.toml still appear, in a separate "Unknown" group — we
 * preserve the data so re-adding the server restores the grant.
 */
export const load: PageServerLoad = async ({ locals, parent }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	await awaitMcpReady();
	const prefs = getUserPreferences(locals.user.id);
	const trusted = prefs?.trustedMcpTools ?? [];
	const servers = listMcpServerStates();
	const groups = new Map<string, { displayName: string; tools: string[] }>();
	for (const tool of trusted) {
		const serverId = extractServerId(tool);
		const groupKey = serverId ?? '_unknown';
		const display =
			serverId === null
				? 'Unknown'
				: (servers.find((s) => s.id === serverId)?.displayName ?? serverId);
		const existing = groups.get(groupKey);
		if (existing) existing.tools.push(tool);
		else groups.set(groupKey, { displayName: display, tools: [tool] });
	}
	return {
		groups: Array.from(groups.entries()).map(([id, value]) => ({
			id,
			displayName: value.displayName,
			tools: value.tools.sort()
		}))
	};
};

function extractServerId(toolName: string): string | null {
	if (!toolName.startsWith('mcp__')) return null;
	const rest = toolName.slice('mcp__'.length);
	const idx = rest.indexOf('__');
	if (idx < 1) return null;
	return rest.slice(0, idx);
}
