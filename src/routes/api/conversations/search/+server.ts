import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { searchConversations } from '$lib/server/db/queries/search';
import type { RequestHandler } from './$types';

/**
 * Owner-scoped full-text search across the user's conversations.
 *
 * Query params:
 *   ?q=…    user-typed search string (sanitized by buildFtsQuery)
 *
 * Always returns 200 with `{ results }`. Empty query / no matches both
 * surface as `results: []` — the client renders an appropriate empty
 * state for each.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);
	const q = url.searchParams.get('q') ?? '';
	const results = searchConversations(locals.user.id, q);
	return json({ results });
};
