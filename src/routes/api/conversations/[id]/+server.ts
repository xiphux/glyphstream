import { error, json } from '@sveltejs/kit';
import {
	deleteConversation,
	getConversationDetail
} from '$lib/server/db/queries/conversations';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const conv = getConversationDetail(params.id, locals.user.id);
	if (!conv) throw error(404, 'Conversation not found');
	return json({ conversation: conv });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const ok = deleteConversation(params.id, locals.user.id);
	if (!ok) throw error(404, 'Conversation not found');
	return new Response(null, { status: 204 });
};
