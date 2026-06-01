/**
 * POST /api/conversations/:id/messages/:messageId/select
 *
 * Switch the active branch to the one containing this message. The server
 * walks down from `messageId` to the deepest descendant (greatest
 * created_at, breaking ties by id) and points `active_leaf_message_id`
 * there. The previously-active branch's tail messages stay in the DB as
 * an alternate sibling chain — the next call to /select can switch back.
 *
 * Used by the `‹ N/M ›` branch-nav UI when the user clicks to a sibling
 * of the currently-shown message.
 */

import { json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { selectBranch } from '$lib/server/db/queries/messages';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	requireUser(locals);

	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');
	const result = requireFound(
		selectBranch(params.id, params.messageId),
		'Message not found in this conversation',
	);

	return json({ activeLeafMessageId: result.newActiveLeaf });
};
