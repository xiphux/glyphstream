/**
 * Admin user-management mutations (admin only):
 *   PATCH  /api/admin/users/[id]  { disabled: boolean }  — enable/disable
 *   DELETE /api/admin/users/[id]                          — delete + cascade, stop in-flight generations, unlink media files
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
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import { cancelInFlightGenerations } from '$lib/server/streaming/cancel';
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

/**
 * The shared precondition gate for every admin user mutation, run in a fixed
 * order so a new mutation can't accidentally skip or reorder a check: reject
 * acting on your own account (self-lockout footgun), 404 a missing target, and
 * (when the action could remove an admin) reject stranding the last one.
 * Messages are caller-supplied so each verb reads naturally.
 */
function assertCanMutateTargetUser(
	actorId: string,
	targetId: string,
	opts: { selfMessage: string; strand: boolean; strandMessage: string },
): void {
	if (targetId === actorId) error(400, opts.selfMessage);
	if (getUserRole(targetId) === null) error(404, 'User not found');
	if (opts.strand && wouldStrandAdmins(targetId)) error(409, opts.strandMessage);
}

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireAdmin(locals);
	const body = await parseJsonBody<{ disabled?: unknown }>(request);
	if (typeof body.disabled !== 'boolean') {
		error(400, '`disabled` must be a boolean');
	}
	assertCanMutateTargetUser(locals.user.id, params.id, {
		selfMessage: 'You cannot change your own account from the admin panel',
		// Only disabling an admin can strand the instance; enabling never does.
		strand: body.disabled,
		strandMessage: 'Cannot disable the last active administrator',
	});
	if (!setUserDisabled(params.id, body.disabled)) error(404, 'User not found');
	return json({ ok: true });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireAdmin(locals);
	assertCanMutateTargetUser(locals.user.id, params.id, {
		selfMessage: 'You cannot delete your own account from the admin panel',
		strand: true,
		strandMessage: 'Cannot delete the last active administrator',
	});
	const deleted = deleteUser(params.id);
	if (!deleted) error(404, 'User not found');
	// Stop anything still generating into the deleted conversations, as
	// conversation delete does: otherwise the upstream keeps working (holding an
	// endpoint slot) for a reply with nowhere to go, and a media generation that
	// hasn't reached its persist step won't write a file after the unlink below.
	// (One already past its abort check can still land a file with no row.) Local
	// aborts are synchronous; the video bridge cancels aren't awaited.
	for (const conversationId of deleted.conversationIds) {
		void cancelInFlightGenerations(conversationId).catch((e: unknown) => {
			console.warn('[admin.users.delete] cancelling in-flight generation failed:', e);
		});
	}
	// The cascade removed the media rows; the bytes (and their thumbnails and
	// vision variants) are only reachable from here.
	await unlinkMediaFiles(deleted.files, 'admin.users.delete');
	return json({ ok: true });
};
