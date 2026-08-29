/**
 * POST /api/conversations/:id/avatar/prepare
 *
 * Opens a multi-model avatar comparison: park the fan-out on the appearance
 * description and hand back the portraits already drawn from it. The client
 * then fires N branch requests at ../generate (each `fanout: true`, anchored on
 * the same description) which stream concurrently into sibling portraits.
 *
 * The sibling of .../messages/prepare, and it exists for the second of that
 * route's two reasons, not the first. There's no shared user message to create —
 * an avatar draw hangs off an assistant message that already exists — but the
 * fan-out marker still has to be parked exactly once, before any branch, and the
 * seed list can only be read once from one place.
 *
 * WHY THE SEED. `getFanoutRecoveryState` rebuilds a parked grid from every
 * assistant child of the anchor, so a grid recovered after a reload shows every
 * portrait ever drawn from this description. The live grid has to agree, and the
 * page can't produce that list: it renders the ACTIVE branch, which holds at
 * most one of those siblings. Reading them here is what keeps "reload mid-draw"
 * from silently growing the grid.
 *
 * WHERE A COMPARISON IS ALLOWED. Recovery only reports a fan-out whose marker is
 * the active leaf, so the leaf has to end up on the description. It's already
 * there for a first draw. For a re-roll it sits on the portrait drawn last, and
 * stepping back onto its parent is safe precisely while that portrait is a dead
 * end — it comes straight back as a column. Once the conversation has continued
 * past the description, those turns hang off one particular portrait, and
 * picking a different one would strand them: refused here, and the client offers
 * only the single-model background draw.
 */

import { error, json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { getConversationMeta, setFanoutParent } from '$lib/server/db/queries/conversations';
import {
	getMessage,
	getSiblingAssistants,
	hasChildMessages,
	setActiveLeafMessageId,
} from '$lib/server/db/queries/messages';
import type { PrepareAvatarDrawResponse } from '$lib/types/api';
import type { RequestHandler } from './$types';

interface PrepareAvatarDrawBody {
	/** The appearance description the portraits hang under. */
	sourceMessageId?: unknown;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);

	const meta = requireFound(
		getConversationMeta(params.id, locals.user.id),
		'Conversation not found',
	);

	const body = await parseJsonBody<PrepareAvatarDrawBody>(request);
	if (typeof body.sourceMessageId !== 'string' || !body.sourceMessageId) {
		error(400, "'sourceMessageId' is required");
	}
	const source = getMessage(params.id, body.sourceMessageId);
	if (!source) error(404, 'Message not found');

	const leaf = meta.activeLeafMessageId;
	if (leaf && leaf !== source.id) {
		const leafMessage = getMessage(params.id, leaf);
		const parkable =
			leafMessage?.parentMessageId === source.id && !hasChildMessages(params.id, leaf);
		if (!parkable) {
			error(
				409,
				'This conversation has moved on past that message — draw with a single model instead.',
			);
		}
		setActiveLeafMessageId(params.id, source.id);
	}
	setFanoutParent(params.id, locals.user.id, source.id);

	const response: PrepareAvatarDrawResponse = {
		siblings: getSiblingAssistants(params.id, source.id),
	};
	return json(response);
};
