/**
 * DELETE /api/user/memories/:id — forget a saved memory.
 *
 * Scoped to the caller via the query layer's user_id WHERE clause, so a
 * fabricated or foreign id surfaces as a 404 rather than touching
 * another user's row. The settings page calls this; the model uses the
 * forget_memory tool, not this endpoint.
 */
import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { deleteMemory } from '$lib/server/db/queries/memories';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const matched = deleteMemory(locals.user.id, params.id);
	if (!matched) throw error(404, 'Memory not found');
	return new Response(null, { status: 204 });
};
