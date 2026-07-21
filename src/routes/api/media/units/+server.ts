import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listGalleryUnits } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * A contiguous slice of the gallery's newest-first top-level unit stream, for
 * the virtualized grid's demand loader. Offset-paged: the client derives the
 * absolute unit index it needs from the layout counts (see /api/media/layout)
 * and fetches that window, rendering placeholder tiles until it lands.
 *
 * Query params:
 *   ?offset=N           absolute unit index to start at (default 0)
 *   ?limit=N            units to return (default 120, capped 500)
 *   ?kind / ?model / ?tzOffset   same filters as /layout (must match, so the
 *                       offsets line up with the reserved section heights)
 */
export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);

	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : undefined;
	const model = url.searchParams.get('model') ?? undefined;
	const tzParam = url.searchParams.get('tzOffset');
	const tz = tzParam ? Number.parseInt(tzParam, 10) : undefined;
	const offsetParam = url.searchParams.get('offset');
	const limitParam = url.searchParams.get('limit');
	const offset = offsetParam ? Number.parseInt(offsetParam, 10) : 0;
	const limit = limitParam ? Number.parseInt(limitParam, 10) : undefined;
	const stack = url.searchParams.get('stack') !== 'false';

	const page = listGalleryUnits(locals.user.id, {
		kind,
		model,
		tzOffsetMinutes: Number.isFinite(tz) ? tz : undefined,
		stack,
		offset: Number.isFinite(offset) ? offset : 0,
		limit: limit != null && Number.isFinite(limit) ? limit : undefined,
	});
	return json(page);
};
