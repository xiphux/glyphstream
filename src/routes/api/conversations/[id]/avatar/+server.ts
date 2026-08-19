/**
 * PUT / DELETE /api/conversations/:id/avatar
 *
 * The per-conversation avatar override — the face this chat's model wears,
 * winning over whatever its preset supplies. Separate from the preset endpoint
 * because they're different rows with different lifetimes: changing a
 * conversation's face must not retroactively repaint every other chat built on
 * the same preset.
 *
 * Same split as the preset route: the upload (if any) goes through
 * /api/uploads first, and this only ever moves a reference.
 */

import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { setConversationAvatar } from '$lib/server/db/queries/conversations';
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

	const result = setConversationAvatar(params.id, locals.user.id, body.mediaId.trim());
	if (!result.ok) {
		if (result.reason === 'not_found') error(404, 'Conversation not found');
		error(400, 'Media not found');
	}
	return json({ ok: true });
};

export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const result = setConversationAvatar(params.id, locals.user.id, null);
	if (!result.ok) error(404, 'Conversation not found');
	return json({ ok: true });
};
