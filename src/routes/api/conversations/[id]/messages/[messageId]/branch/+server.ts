/**
 * DELETE /api/conversations/:id/messages/:messageId/branch
 *
 * Delete an alternate-branch sibling and its entire subtree of descendants.
 * Drives both the "trash this branch" affordance in the chat action row
 * (gated to render only when the message has siblings) and the media
 * fan-out's per-column discard.
 *
 * Returns 204 on success. 400 only when the delete would strand the active
 * leaf — the leaf sits inside the deleted subtree and there's no sibling to
 * reassign it to (a truncate, not exposed here); deleting a childless branch
 * whose leaf lives elsewhere (a parked fan-out) is allowed. 404 if the
 * conversation or message can't be found under the calling user.
 *
 * The DB query (`deleteBranch`) handles the order-sensitive bookkeeping:
 * reassign active_leaf to a sibling's deepest descendant (only when the leaf
 * was inside the deleted subtree), hard-delete
 * generated media that exists only inside the deleted subtree, decrement
 * media refs for the remaining (still-referenced) media, then delete the
 * messages. This endpoint is responsible for unlinking the orphan-media
 * bytes from disk after the DB transaction commits — that step has to
 * happen outside the txn (file unlinks aren't transactional, so doing
 * them inside would mean a rolled-back transaction could leave files
 * deleted from disk but still referenced from the DB).
 */

import { error } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { deleteBranch } from '$lib/server/db/queries/messages';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);

	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');

	const result = requireFound(
		deleteBranch(params.id, params.messageId, locals.user.id),
		'Message not found in this conversation',
	);
	if ('refusedReason' in result) {
		throw error(400, 'Cannot delete a branch that has no siblings');
	}

	// Unlink orphaned media bytes after the txn commits (see the file
	// header and unlinkMediaFiles for the ordering rationale).
	await unlinkMediaFiles(result.toUnlink, 'branch.delete');

	return new Response(null, { status: 204 });
};
