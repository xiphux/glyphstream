import { searchMediaForUser } from '#lib/server/media/gallery-search.js';
import { cachedModelFacets } from '#lib/server/gallery/layout.js';
import { friendlyModelName } from '#lib/model-ids.js';
import type { PageServerLoad } from './$types';

/**
 * Initial gallery payload. Two modes:
 *   - Browse (chronological): the virtualized grid is layout-driven. We do NOT
 *     SSR the grid — the layout's day buckets depend on the viewer's tz offset
 *     (which the server can't know), so the client fetches /api/media/layout +
 *     the first /api/media/units page on mount with its real offset. That's one
 *     correct load instead of an SSR-then-refetch (which would flash the grid
 *     and race in-progress interactions). A skeleton covers the round-trip.
 *   - Search (ranked): best-match-first, or newest-first under `?sort=new` — no
 *     stacking/sections/tz, SSR'd as the flat item list. The sort is the
 *     server's, not a client re-sort, because the result set is capped: the
 *     newest 150 matches aren't the best-scoring 150 put in date order.
 */
export const load: PageServerLoad = async ({ locals, parent, url }) => {
	// Wait for the (app) layout's auth check before deref'ing locals.user.
	await parent();
	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : null;
	const model = url.searchParams.get('model') ?? null;
	const q = url.searchParams.get('q')?.trim() || null;
	const favorite = url.searchParams.get('fav') === '1';
	const sort =
		url.searchParams.get('sort') === 'new' ? ('newest' as const) : ('relevance' as const);
	const userId = locals.user!.id;

	// Facet options for the Model dropdown. Labels via the pure `friendlyModelName`
	// (no upstream fetch); the raw `value` is what `?model=` filters on.
	const modelFacets = cachedModelFacets(userId, {
		kind: kind ?? undefined,
		favorite,
	}).map((f) => ({ ...f, label: friendlyModelName(f.value) }));

	if (q) {
		const searchItems = await searchMediaForUser(userId, q, {
			kind: kind ?? undefined,
			model: model ?? undefined,
			favorite,
			sort,
		});
		return { mode: 'search' as const, searchItems, kind, model, favorite, q, sort, modelFacets };
	}

	return { mode: 'browse' as const, kind, model, favorite, q: null, sort, modelFacets };
};
