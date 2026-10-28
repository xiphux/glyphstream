/**
 * PATCH /api/conversations/:id/photos/:photoId — `{ shown: true }` puts this
 * version of a photo or portrait on show: the arrows, and the pick in a
 * comparison. Showing a photo changes nothing the model sees; showing a
 * portrait also makes it the conversation's face. A pick from a comparison
 * (`pick: true`) also counts it in model stats — once, for the versions the
 * server drew in that comparison (see `resolveComparison`).
 *
 * Removing a version is the image's own delete (`DELETE /api/media/:id`): it
 * goes to the trash, the version stops showing, and restoring the image brings
 * it back.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { parseJsonBody } from '#lib/server/http.js';
import { resolveComparison, showMessageImage } from '#lib/server/db/queries/message-images.js';
import { setConversationAvatar } from '#lib/server/db/queries/conversations.js';
import { recordPhotoComparisonPick } from '#lib/server/stats/reactions.js';
import { recordMediaEvent } from '#lib/server/stats/model-stats.js';
import { closePhotoComparison } from '#lib/server/generation/jobs.js';
import type { RequestHandler } from './$types';

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ shown?: unknown; pick?: unknown }>(request);
	if (body.shown !== true) error(400, "'shown' must be true");
	const shown = showMessageImage(locals.user.id, params.id, params.photoId);
	if (!shown) error(404, 'Photo not found');
	if (shown.kind === 'portrait') {
		const applied = setConversationAvatar(params.id, locals.user.id, shown.mediaId);
		if (!applied.ok) error(404, 'Photo not found');
		if (applied.changed) recordMediaEvent([shown.mediaId], 'avatar_set');
	}
	if (body.pick === true) {
		const compared = resolveComparison(locals.user.id, params.id, params.photoId);
		if (compared) {
			recordPhotoComparisonPick(compared.winner, compared.models, shown.kind);
			closePhotoComparison(compared.messageId, compared.comparisonId);
		}
	}
	return new Response(null, { status: 204 });
};
