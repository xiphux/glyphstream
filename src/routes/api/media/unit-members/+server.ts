import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listGalleryUnitMembers } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * The complete member set of one gallery stack, for drilling in. The grid holds
 * only thin units (≤4 preview ids), so opening a stack fetches its full members
 * here — a conversation stack (`?key=<conversationId>`) or a same-prompt run
 * (`?key=p:<leaderId>`). Mirrors the gallery's kind/model filters so a drill-in
 * stays consistent with an active filter. Ownership is enforced in the query.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);
	const key = url.searchParams.get('key');
	if (!key) return json({ items: [] });
	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : undefined;
	const model = url.searchParams.get('model') ?? undefined;
	const items = listGalleryUnitMembers(locals.user.id, key, { kind, model });
	return json({ items });
};
