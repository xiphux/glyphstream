import {
	listDistinctSourceModelsForUser,
	listMediaForUser,
	searchMediaForUser,
} from '$lib/server/db/queries/media';
import { friendlyModelName } from '$lib/server/endpoints/friendly-name';
import type { PageServerLoad } from './$types';

/**
 * Initial gallery payload. The client subsequently calls /api/media for
 * pagination + filter changes. We render the first page server-side so the
 * grid has content on first paint instead of a loading spinner.
 */
export const load: PageServerLoad = async ({ locals, parent, url }) => {
	// Wait for the (app) layout's auth check before deref'ing locals.user.
	// See /(app)/+page.server.ts for why.
	await parent();
	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : null;
	const model = url.searchParams.get('model') ?? null;
	const q = url.searchParams.get('q')?.trim() || null;
	const userId = locals.user!.id;

	// Search is a relevance-ranked mode (best-match-first, no cursor); the
	// chronological browse uses the keyset-paginated listing. Both apply the
	// kind/model facets so search composes with them.
	const initial = q
		? {
				items: await searchMediaForUser(userId, q, {
					kind: kind ?? undefined,
					model: model ?? undefined,
				}),
				nextCursor: null,
			}
		: listMediaForUser(userId, {
				kind: kind ?? undefined,
				model: model ?? undefined,
			});

	// Facet options for the Model dropdown. Labels are derived with the pure
	// `friendlyModelName` (no upstream fetch) so the load stays light; the
	// raw `value` is what `?model=` filters on.
	const modelFacets = listDistinctSourceModelsForUser(userId, {
		kind: kind ?? undefined,
	}).map((f) => ({ ...f, label: friendlyModelName(f.value) }));

	return { initial, kind, model, q, modelFacets };
};
