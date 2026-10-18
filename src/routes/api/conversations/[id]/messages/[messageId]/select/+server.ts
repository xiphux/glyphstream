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
 * of the currently-shown message, and by a comparison's Pick and Done.
 *
 * `?pick=1` marks an explicit Pick, for the model stats. Done selects the first
 * column on the user's behalf and ‹N/M› is browsing, and neither says the
 * selected reply won anything — so the server can't infer a pick from the
 * selection alone. It also has to resolve the comparison actually parked here.
 */

import { requireFound, requireUser } from '#lib/server/auth/guard.js';
import { getConversationMeta } from '#lib/server/db/queries/conversations.js';
import { selectBranch } from '#lib/server/db/queries/messages.js';
import { pendingComparisonPick, recordComparisonPick } from '#lib/server/stats/reactions.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = ({ locals, params, url }) => {
	requireUser(locals);

	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');
	const picked =
		url.searchParams.get('pick') === '1'
			? pendingComparisonPick(params.id, locals.user.id, params.messageId)
			: null;
	const result = requireFound(
		selectBranch(params.id, params.messageId),
		'Message not found in this conversation',
	);

	if (picked) recordComparisonPick(params.id, picked, 'fanout');

	return Response.json({ activeLeafMessageId: result.newActiveLeaf });
};
