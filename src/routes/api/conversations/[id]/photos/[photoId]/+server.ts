/**
 * PATCH /api/conversations/:id/photos/:photoId — `{ shown: true }` puts this
 * version of a photo on show: the arrows on a photo, and the pick in a
 * comparison. Showing changes nothing the model sees. A pick from a
 * comparison (`pick: true`) also counts it in model stats — once, for the
 * versions the server drew in that comparison (see `resolveComparison`).
 *
 * Removing a version is the image's own delete (`DELETE /api/media/:id`): it
 * goes to the trash, the version stops showing, and restoring the image brings
 * it back.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { parseJsonBody } from '#lib/server/http.js';
import { resolveComparison, showMessageImage } from '#lib/server/db/queries/message-images.js';
import { recordPhotoComparisonPick } from '#lib/server/stats/reactions.js';
import { closePhotoComparison } from '#lib/server/generation/jobs.js';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ shown?: unknown; pick?: unknown }>(request);
	if (body.shown !== true) error(400, "'shown' must be true");
	if (!showMessageImage(locals.user.id, params.id, params.photoId)) {
		error(404, 'Photo not found');
	}
	if (body.pick === true) {
		const compared = resolveComparison(locals.user.id, params.id, params.photoId);
		if (compared) {
			recordPhotoComparisonPick(compared.winner, compared.models);
			closePhotoComparison(compared.messageId, compared.comparisonId);
		}
	}
	return new Response(null, { status: 204 });
};
