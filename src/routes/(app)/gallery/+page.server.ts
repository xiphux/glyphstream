import { listMediaForUser } from '$lib/server/db/queries/media';
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
	const initial = listMediaForUser(locals.user!.id, { kind: kind ?? undefined });
	return { initial, kind };
};
