import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { computeGalleryLayout } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * The gallery's virtualization layout: per-day top-level *unit* counts (stacks
 * collapsed), newest-first, plus the total. The client reserves exact scroll
 * height from these before streaming any unit data, so the scrollbar is stable
 * from first paint. Unit counts (not media counts) because stacking collapses
 * many media into one tile — computed server-side since conversation stacks are
 * global and can't be counted from a client-side region in isolation.
 *
 * Query params (all optional, mirroring the gallery feed's filters):
 *   ?kind=image|video   restrict to a modality
 *   ?model=…            restrict to an exact source_model
 *   ?tzOffset=N         viewer's UTC offset in minutes (-getTimezoneOffset()),
 *                       so days bucket in local time (matches the unit dayKeys)
 */
export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);

	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : undefined;
	const model = url.searchParams.get('model') ?? undefined;
	const tzParam = url.searchParams.get('tzOffset');
	const tz = tzParam ? Number.parseInt(tzParam, 10) : undefined;
	const stack = url.searchParams.get('stack') !== 'false';

	const layout = computeGalleryLayout(locals.user.id, {
		kind,
		model,
		tzOffsetMinutes: Number.isFinite(tz) ? tz : undefined,
		stack,
	});
	return json(layout);
};
