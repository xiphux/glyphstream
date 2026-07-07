/**
 * POST /api/user/memories/:id/restore — un-delete a dreaming-tombstoned memory.
 *
 * The settings "Recently tidied" list calls this to recover a memory the
 * dreaming pass merged/pruned. Scoped to the caller via the query layer's
 * user_id WHERE clause, so a fabricated or foreign id surfaces as a 404 rather
 * than touching another user's row. A dedicated `restore` sub-route (POST =
 * un-delete) mirrors the sibling `[id]` DELETE (forget). Restore is
 * non-destructive, so unlike forget the client issues it without a confirm step.
 */
import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { restoreMemory } from '$lib/server/db/queries/memories';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const matched = restoreMemory(locals.user.id, params.id);
	if (!matched) throw error(404, 'Memory not found');
	return new Response(null, { status: 204 });
};
