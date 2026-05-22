/**
 * DELETE /api/conversations/:id/messages/:messageId/branch
 *
 * Delete an alternate-branch sibling and its entire subtree of descendants.
 * Drives the "trash this branch" affordance in the chat action row, which
 * is gated to only render when the message has siblings.
 *
 * Returns 204 on success. 400 if the message has no siblings (deleting it
 * would just truncate the conversation — a different operation, not
 * exposed here). 404 if the conversation or message can't be found under
 * the calling user.
 *
 * The DB query (`deleteBranch`) handles the order-sensitive bookkeeping:
 * reassign active_leaf to a sibling's deepest descendant, hard-delete
 * generated media that exists only inside the deleted subtree, decrement
 * media refs for the remaining (still-referenced) media, then delete the
 * messages. This endpoint is responsible for unlinking the orphan-media
 * bytes from disk after the DB transaction commits — that step has to
 * happen outside the txn (file unlinks aren't transactional, so doing
 * them inside would mean a rolled-back transaction could leave files
 * deleted from disk but still referenced from the DB).
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { deleteBranch } from '$lib/server/db/queries/messages';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);

	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) throw error(404, 'Conversation not found');

	const result = deleteBranch(params.id, params.messageId, locals.user.id);
	if (!result) throw error(404, 'Message not found in this conversation');
	if ('refusedReason' in result) {
		throw error(400, 'Cannot delete a branch that has no siblings');
	}

	// Unlink orphaned media bytes after the txn commits (see the file
	// header and unlinkMediaFiles for the ordering rationale).
	await unlinkMediaFiles(result.toUnlink, 'branch.delete');

	return new Response(null, { status: 204 });
};
