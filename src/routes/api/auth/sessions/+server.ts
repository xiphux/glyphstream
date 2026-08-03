/**
 * DELETE /api/auth/sessions — sign out everywhere else.
 *
 * Drops every session for the caller except the one making the request, so
 * an unrecognized device can be evicted without signing yourself out too.
 *
 * The listing side isn't here: /settings/security SSRs its device list in
 * the page load, and adding a GET would be a second way to read the same
 * rows. Revocation is the only thing that needs an endpoint.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { revokeOtherSessionsForUser } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ locals }) => {
	requireUser(locals);
	// requireUser narrows `user`, not `sessionId` — but a resolved user always
	// came from a resolved session, so this is a defensive 401 rather than a
	// reachable one. Without the guard we'd pass undefined as the id to keep
	// and sign the caller out of their own session too.
	if (!locals.sessionId) throw error(401, 'Authentication required');
	const revoked = revokeOtherSessionsForUser(locals.user.id, locals.sessionId);
	return json({ revoked });
};
