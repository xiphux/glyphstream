import { requireFound, requireUser } from '#lib/server/auth/guard.js';
import { deleteCheckIn } from '#lib/server/db/queries/check-ins.js';
import { getConversationMeta } from '#lib/server/db/queries/conversations.js';
import type { RequestHandler } from './$types';

/**
 * Cancel the conversation's pending texting check-in. Idempotent — one that
 * already fired (or was never set) is gone either way, so it succeeds quietly.
 */
export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');
	return Response.json({ cancelled: deleteCheckIn(params.id, locals.user.id) });
};
