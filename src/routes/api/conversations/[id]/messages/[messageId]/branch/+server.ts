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
 * reassign active_leaf to a sibling's deepest descendant first, decrement
 * media refs for the deletion set, then delete the messages.
 */

import { error } from '@sveltejs/kit';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { deleteBranch } from '$lib/server/db/queries/messages';
import type { RequestHandler } from './$types';

export const DELETE: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) throw error(404, 'Conversation not found');

	const result = deleteBranch(params.id, params.messageId);
	if (!result) throw error(404, 'Message not found in this conversation');
	if ('refusedReason' in result) {
		throw error(400, 'Cannot delete a branch that has no siblings');
	}

	return new Response(null, { status: 204 });
};
