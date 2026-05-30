import { error } from '@sveltejs/kit';
import { awaitMcpReady } from '$lib/server/mcp/bootstrap';
import { listMcpServerStates } from '$lib/server/mcp/registry';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, parent }) => {
	await parent();
	if (!locals.user) throw error(401, 'Authentication required');
	await awaitMcpReady();
	return {
		servers: listMcpServerStates().map((s) => ({
			id: s.id,
			displayName: s.displayName,
			transport: s.transport,
			state: s.state,
			error: s.error ?? null,
			tools: s.tools.map((t) => ({
				name: t.name,
				description: t.description ?? ''
			}))
		}))
	};
};
