import { error } from '@sveltejs/kit';
import { getUserPreferences } from '$lib/server/db/queries/user-preferences';
import { awaitMcpReady } from '$lib/server/mcp/bootstrap';
import { getUserServerStates } from '$lib/server/mcp/registry';
import { buildRegisteredName } from '$lib/server/mcp/tool-bridge';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent, depends }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	// Tagged so the page can `invalidate('settings:mcp')` after a retry, a
	// credential change, or a trust toggle without re-running the (app) layout.
	depends('settings:mcp');
	await awaitMcpReady();
	// Surface the user's trusted-tools list here too so each tool row can show
	// its current grant state — letting the user pre-allow tools without
	// waiting for the first invocation's approval card.
	const trusted = new Set(getUserPreferences(locals.user.id)?.trustedMcpTools ?? []);
	// Per-user states: global servers report the shared connection; per-user
	// servers report this user's connection (or `needs-credential`).
	const states = await getUserServerStates(locals.user.id);
	return {
		servers: states.map((s) => ({
			id: s.id,
			displayName: s.displayName,
			transport: s.transport,
			auth: s.auth,
			perUser: s.auth === 'per_user',
			configured: s.configured,
			state: s.state,
			error: s.error ?? null,
			tools: s.tools.map((t) => {
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
