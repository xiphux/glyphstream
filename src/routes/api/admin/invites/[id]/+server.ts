/**
 * DELETE /api/admin/invites/[id] — revoke an invite (admin only). Works on
 * both unredeemed and already-redeemed invites; deleting a redeemed invite
 * just drops its audit row and doesn't affect the user it created.
 */
import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { deleteInvite } from '$lib/server/db/queries/invites';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (!deleteInvite(params.id)) throw error(404, 'Invite not found');
	return json({ ok: true });
};
