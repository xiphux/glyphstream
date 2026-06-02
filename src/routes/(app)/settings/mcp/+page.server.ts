import { error } from '@sveltejs/kit';
import { getUserPreferences } from '$lib/server/db/queries/user-preferences';
import { awaitMcpReady } from '$lib/server/mcp/bootstrap';
import { listMcpServerStates } from '$lib/server/mcp/registry';
import { buildRegisteredName } from '$lib/server/mcp/tool-bridge';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	// Tagged so the page can `invalidate('settings:mcp')` after a retry
	// or trust toggle without re-running the (app) layout — none of the
	// layout's data (conversations, models, prefs, custom models, feature
	// categories) is affected by MCP state changes.
	depends('settings:mcp');
	await awaitMcpReady();
	// Surface the user's trusted-tools list here too so each tool row
	// can show its current grant state. Lets the user skim the server's
	// advertised tools and bulk-pre-allow the ones they're comfortable
	// with — no need to wait for the first invocation just to hit
	// "Allow always" on the inline approval card.
	const trusted = new Set(getUserPreferences(locals.user.id)?.trustedMcpTools ?? []);
	return {
		servers: listMcpServerStates().map((s) => ({
			id: s.id,
			displayName: s.displayName,
			transport: s.transport,
			state: s.state,
			error: s.error ?? null,
			tools: s.tools.map((t) => {
				// Same namespaced name the tool-bridge registers so the
				// page can PUT/DELETE against the trusted-tools endpoint
				// with no client-side string assembly.
				const registeredName = buildRegisteredName(s.id, t.name);
				return {
					name: t.name,
					registeredName,
					description: t.description ?? '',
					trusted: trusted.has(registeredName),
				};
			}),
		})),
	};
};
