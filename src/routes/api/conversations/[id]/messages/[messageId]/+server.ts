import { requireFound, requireUser } from '#lib/server/auth/guard.js';
import { getConversationMeta } from '#lib/server/db/queries/conversations.js';
import { truncateAtMessage } from '#lib/server/db/queries/messages.js';
import type { RequestHandler } from './$types';

/**
 * "Edit" v1 behavior: truncate the active branch at this message — set
 * active_leaf to the message's parent. The message + descendants stay in
 * the DB (unreachable until v2's branch UI exposes them as siblings).
 *
 * Client is expected to follow up with a fresh POST /messages to continue.
 */
export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);

	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');
	const result = requireFound(
		truncateAtMessage(params.id, params.messageId),
		'Message not found in this conversation',
	);

	return Response.json({ activeLeafMessageId: result.newActiveLeaf });
};
