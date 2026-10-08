import { error, json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import {
	getMediaListItemForUser,
	setMediaFavorite,
	trashMediaForUser,
} from '$lib/server/db/queries/media';
import { parseJsonBody } from '$lib/server/http';
import type { RequestHandler } from './$types';

/**
 * Metadata fetch for a single media row, in the same MediaListItem shape
 * the gallery uses. Drives the chat-side lightbox: message parts only
 * carry `mediaId`, so the source model + prompt excerpt + size etc. need
 * a one-shot fetch when the user taps an image. Ownership-checked.
 */
export const GET: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	const m = requireFound(getMediaListItemForUser(params.id, locals.user.id), 'Media not found');
	return json(m);
};

/**
 * Star / unstar one media row (the gallery + lightbox favorite toggle).
 *
 * 404 covers not-found, not-yours, already-tombstoned, AND an uploaded row:
 * favorites are generated-only, because the gallery — the only place a favorite
 * can be found again — never lists uploads. The client withholds the star in
 * that case rather than relying on this, so a 404 here means stale state, not a
 * routine outcome.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ favorite?: unknown }>(request);
	if (typeof body.favorite !== 'boolean') {
		error(400, 'favorite must be a boolean');
	}
	if (!setMediaFavorite(params.id, locals.user.id, body.favorite)) {
		error(404, 'Media not found');
	}
	return new Response(null, { status: 204 });
};

/**
 * Gallery delete: moves the row to the trash ("Recently deleted"). Old
 * conversation messages that referenced this media subsequently 404 on
 * /content (graceful broken-image in the UI) unless it's restored. Idempotent:
 * a 404 here means the row was already gone or already deleted.
 */
export const DELETE: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	if (!trashMediaForUser(params.id, locals.user.id)) error(404, 'Media not found');
	return new Response(null, { status: 204 });
};
