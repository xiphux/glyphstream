import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listGalleryUnitMembers } from '$lib/server/gallery/layout';
import type { RequestHandler } from './$types';

/**
 * The complete member set of one gallery stack, for drilling in. The grid holds
 * only thin units (≤4 preview ids), so opening a stack fetches its full members
 * here — a conversation stack (`?key=<conversationId>`) or a same-prompt run
 * (`?key=p:<leaderId>`). Mirrors the gallery's kind/model/fav filters so a
 * drill-in shows the same members the collapsed card counted, not the unfiltered
 * bucket. Ownership is enforced in the query.
 */
export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);
	const key = url.searchParams.get('key');
	if (!key) return json({ items: [] });
	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : undefined;
	const model = url.searchParams.get('model') ?? undefined;
	const favorite = url.searchParams.get('fav') === '1';
	const items = listGalleryUnitMembers(locals.user.id, key, { kind, model, favorite });
	return json({ items });
};
