/**
 * Revoke a single "always allow" grant. The tool's namespaced name
 * (mcp__<server>__<tool>) is the path parameter — same shape stored in
 * UserPreferences.trustedMcpTools. 204 on a removal, 404 when the grant
 * isn't on file.
 */

import { error } from '@sveltejs/kit';
import {
	getUserPreferences,
	setUserPreferences
} from '$lib/server/db/queries/user-preferences';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ params, locals }) => {
	if (!locals.user) throw error(401, 'Sign in to continue.');
	const name = params.name;
	if (!name) throw error(400, "Missing tool name in path");
	const prefs = getUserPreferences(locals.user.id);
	const trusted = prefs?.trustedMcpTools ?? [];
	if (!trusted.includes(name)) return new Response(null, { status: 404 });
	setUserPreferences(locals.user.id, {
		trustedMcpTools: trusted.filter((t) => t !== name)
	});
	return new Response(null, { status: 204 });
};
