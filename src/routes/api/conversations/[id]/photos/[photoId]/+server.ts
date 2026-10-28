/**
 * PATCH /api/conversations/:id/photos/:photoId — `{ shown: true }` puts this
 * version of a photo on show: the arrows on a photo, and the pick in a
 * comparison. Showing changes nothing the model sees. A pick also names the
 * versions it was compared with (`comparedWith`), which is what counts it in
 * model stats.
 *
 * Removing a version is the image's own delete (`DELETE /api/media/:id`): it
 * goes to the trash, the version stops showing, and restoring the image brings
 * it back.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { parseJsonBody } from '#lib/server/http.js';
import { comparedModels, showMessageImage } from '#lib/server/db/queries/message-images.js';
import { recordPhotoComparisonPick } from '#lib/server/stats/reactions.js';
import { MAX_FANOUT_BRANCHES_PER_CONVERSATION } from '#lib/fanout.js';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ shown?: unknown; comparedWith?: unknown }>(request);
	if (body.shown !== true) error(400, "'shown' must be true");
	const comparedWith = body.comparedWith;
	if (
		comparedWith !== undefined &&
		(!Array.isArray(comparedWith) ||
			comparedWith.length > MAX_FANOUT_BRANCHES_PER_CONVERSATION ||
			!comparedWith.every((id): id is string => typeof id === 'string'))
	) {
		error(400, "'comparedWith' must be a list of photo ids");
	}
	if (!showMessageImage(locals.user.id, params.id, params.photoId)) {
		error(404, 'Photo not found');
	}
	if (comparedWith) {
		const compared = comparedModels(locals.user.id, params.id, params.photoId, comparedWith);
		if (compared) recordPhotoComparisonPick(compared.winner, compared.models);
	}
	return new Response(null, { status: 204 });
};
