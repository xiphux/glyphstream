import { error, json } from '@sveltejs/kit';
import { listConversationsForMedia } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * Reverse lookup for the gallery lightbox: which of the user's conversations
 * reference this media. Used to surface "this media is in N conversations
 * — click through to clean each up" so deleting a media doesn't silently
 * leave dead-prompt conversations behind.
 *
 * Ownership is enforced inside the query (joins on conversations.user_id),
 * so a foreign or non-existent media id returns `[]` rather than 404 —
 * deliberately same shape as a legitimate orphaned-media case so the UI
 * can render a uniform "0 conversations" message.
 */
export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const conversations = listConversationsForMedia(params.id, locals.user.id);
	return json({ conversations });
};
