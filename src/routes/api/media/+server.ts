import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listMediaForUser } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * Gallery listing: newest non-deleted media for the signed-in user.
 *
 * Query params:
 *   ?kind=image|video   filter by modality (optional)
 *   ?cursor=…           opaque pagination cursor returned by previous call
 *   ?limit=N            max items in this page (default 60, max 200)
 */
export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);

	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : undefined;
	const cursor = url.searchParams.get('cursor') ?? undefined;
	const limitParam = url.searchParams.get('limit');
	const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;

	const page = listMediaForUser(locals.user.id, {
		kind,
		cursor,
		limit: Number.isFinite(limit) ? limit : undefined
	});
	return json(page);
};
