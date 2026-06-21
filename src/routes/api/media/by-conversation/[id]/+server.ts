import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listMediaForConversation } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * The complete member set of one gallery stack — every generated image/video
 * assigned to `params.id` (a conversation), newest-first. The gallery's
 * paginated feed can't guarantee it has loaded all of a conversation's media
 * (it's scattered through the time-ordered stream), so drilling into a
 * conversation card fetches this and merges it in for a guaranteed-complete
 * drill-in.
 *
 * `?kind=image|video` mirrors the gallery's modality filter. Ownership is
 * enforced in the query (media.user_id + user-scoped conversation join), so a
 * foreign/unknown id returns `{ items: [] }`.
 */
export const GET: RequestHandler = ({ locals, params, url }) => {
	requireUser(locals);
	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : undefined;
	const items = listMediaForConversation(params.id, locals.user.id, { kind });
	return json({ items });
};
