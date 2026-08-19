/**
 * PUT / DELETE /api/custom-models/:id/avatar
 *
 * Split out of the preset's PATCH rather than folded into it, mirroring the
 * query layer: setting an avatar moves a media `ref_count` with it, so it gets
 * one write path instead of becoming another optional field on a patch body
 * where a caller could set it without the bookkeeping.
 *
 * The upload itself is NOT here. A client that wants to attach a new image
 * POSTs it to /api/uploads first — that endpoint already owns size caps,
 * content-type classification and the body-limit handling — and then PUTs the
 * media id it gets back. The gap between those two calls is exactly what the
 * purger's grace period is for: an upload the user abandons before this call
 * lands is reaped on schedule, and one that reaches here has a reference and
 * stops being a candidate.
 */

import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { setCustomModelAvatar } from '$lib/server/db/queries/custom-models';
import type { RequestHandler } from './$types';

interface SetAvatarBody {
	mediaId?: unknown;
}

export const PUT: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<SetAvatarBody>(request);
	if (typeof body.mediaId !== 'string' || !body.mediaId.trim()) {
		error(400, "'mediaId' must be a non-empty string");
	}

	const result = setCustomModelAvatar(params.id, locals.user.id, body.mediaId.trim());
	if (!result.ok) {
		// 404 for a preset that isn't the caller's, 400 for a media id that
		// isn't — the two are kept distinct because they mean different things
		// to a client, and neither discloses anything about another user's rows
		// (both collapse "gone" and "not yours" the way every scoped read here
		// already does).
		if (result.reason === 'not_found') error(404, 'Custom model not found');
		error(400, 'Media not found');
	}
	return json({ customModel: result.model });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const result = setCustomModelAvatar(params.id, locals.user.id, null);
	if (!result.ok) error(404, 'Custom model not found');
	return json({ customModel: result.model });
};
