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

import { error, json } from '@sveltejs/kit';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { selectBranch } from '$lib/server/db/queries/messages';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) throw error(404, 'Conversation not found');

	const result = selectBranch(params.id, params.messageId);
	if (!result) throw error(404, 'Message not found in this conversation');

	return json({ activeLeafMessageId: result.newActiveLeaf });
};
