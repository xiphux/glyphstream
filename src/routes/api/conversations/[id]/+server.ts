import { error, json } from '@sveltejs/kit';
import {
	archiveConversation,
	deleteConversation,
	getConversationDetail,
	unarchiveConversation
} from '$lib/server/db/queries/conversations';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const conv = getConversationDetail(params.id, locals.user.id);
	if (!conv) throw error(404, 'Conversation not found');
	return json({ conversation: conv });
};

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const body = (await request.json().catch(() => null)) as { archived?: unknown } | null;
	if (!body || typeof body.archived !== 'boolean') {
		throw error(400, 'Body must be { archived: boolean }');
	}
	const ok = body.archived
		? archiveConversation(params.id, locals.user.id)
		: unarchiveConversation(params.id, locals.user.id);
	if (!ok) throw error(404, 'Conversation not found');
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const ok = deleteConversation(params.id, locals.user.id);
	if (!ok) throw error(404, 'Conversation not found');
	return new Response(null, { status: 204 });
};
