/**
 * Admin user-management mutations (admin only):
 *   PATCH  /api/admin/users/[id]  { disabled: boolean }  — enable/disable
 *   DELETE /api/admin/users/[id]                          — delete + cascade
 *
 * Two invariants the API enforces (not just the UI):
 *   - You can't disable or delete your OWN account here (footgun; an admin
 *     locking themselves out mid-session). Account self-management lives
 *     elsewhere.
 *   - You can't remove the LAST active admin — that would strand the
 *     instance with no one able to reach this UI. We check the would-be
 *     post-state against the target's current role/disabled status.
 */
import { error, json } from '@sveltejs/kit';
import { requireAdmin } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	countActiveAdmins,
	deleteUser,
	getUserRole,
	listUsers,
	setUserDisabled,
} from '$lib/server/db/queries/users';
import type { RequestHandler } from './$types';

/** True when acting on `targetId` would drop the active-admin count to zero. */
function wouldStrandAdmins(targetId: string): boolean {
	const target = listUsers().find((u) => u.id === targetId);
	if (!target) return false;
	const targetIsActiveAdmin = target.role === 'admin' && target.disabledAt === null;
	return targetIsActiveAdmin && countActiveAdmins() <= 1;
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	if (params.id === locals.user.id) {
		throw error(400, 'You cannot change your own account from the admin panel');
	}
	const body = await parseJsonBody<{ disabled?: unknown }>(request);
	if (typeof body.disabled !== 'boolean') {
		throw error(400, '`disabled` must be a boolean');
	}
	if (getUserRole(params.id) === null) throw error(404, 'User not found');
	if (body.disabled && wouldStrandAdmins(params.id)) {
		throw error(409, 'Cannot disable the last active administrator');
	}
	if (!setUserDisabled(params.id, body.disabled)) throw error(404, 'User not found');
	return json({ ok: true });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireAdmin(locals);
	if (params.id === locals.user.id) {
		throw error(400, 'You cannot delete your own account from the admin panel');
	}
	if (getUserRole(params.id) === null) throw error(404, 'User not found');
	if (wouldStrandAdmins(params.id)) {
		throw error(409, 'Cannot delete the last active administrator');
	}
	if (!deleteUser(params.id)) throw error(404, 'User not found');
	return json({ ok: true });
};
