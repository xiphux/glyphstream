import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { truncateAtMessage } from '$lib/server/db/queries/messages';
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

	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) throw error(404, 'Conversation not found');

	const result = truncateAtMessage(params.id, params.messageId);
	if (!result) throw error(404, 'Message not found in this conversation');

	return json({ activeLeafMessageId: result.newActiveLeaf });
};
