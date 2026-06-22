import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { listMediaMonthPeriodsForUser } from '$lib/server/db/queries/media';
import type { RequestHandler } from './$types';

/**
 * The gallery quick-jump timeline: every month the signed-in user has gallery
 * media in, newest-first, with counts. Drives the right-edge tick-rail.
 *
 * Query params (all optional, mirroring the gallery feed's filters):
 *   ?kind=image|video   restrict to a modality
 *   ?model=…            restrict to an exact source_model
 *   ?tzOffset=N         viewer's UTC offset in minutes (-getTimezoneOffset()),
 *                       so months bucket in local time
 */
export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);

	const kindParam = url.searchParams.get('kind');
	const kind = kindParam === 'image' || kindParam === 'video' ? kindParam : undefined;
	const model = url.searchParams.get('model') ?? undefined;
	const tzParam = url.searchParams.get('tzOffset');
	const tz = tzParam ? Number.parseInt(tzParam, 10) : undefined;

	const periods = listMediaMonthPeriodsForUser(locals.user.id, {
		kind,
		model,
		tzOffsetMinutes: Number.isFinite(tz) ? tz : undefined,
	});
	return json({ periods });
};
