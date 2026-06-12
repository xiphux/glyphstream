import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listConversationMediaRefs } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * Navigation set for the in-chat lightbox carousel: every image/video in
 * this conversation, across all branches, oldest first. The chat page
 * fetches this when the lightbox first opens so swipe / arrow navigation
 * can move between sibling generations (multi-image batches, multi-model
 * grids, regenerate revisions) — none of which share the active leaf path
 * the message list is built from.
 *
 * Ownership is enforced inside the query (joins on conversations.user_id),
 * so a foreign or unknown id returns `{ items: [] }` rather than 404 — the
 * caller just gets an inert single-item lightbox in that case.
 */
export const GET: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const items = listConversationMediaRefs(params.id, locals.user.id);
	return json({ items });
};
