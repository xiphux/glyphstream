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
} from '$lib/server/db/queries/messages';
import { getAvatarDrawSince } from '$lib/server/streaming/in-flight';
import type { PrepareAvatarDrawResponse } from '$lib/types/api';
import type { RequestHandler } from './$types';

interface PrepareAvatarDrawBody {
	/** The appearance description the portraits hang under. */
	sourceMessageId?: unknown;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<PrepareAvatarDrawBody>(request);
	if (typeof body.sourceMessageId !== 'string' || !body.sourceMessageId) {
		error(400, "'sourceMessageId' is required");
	}
	// Read AFTER the body, not before it. Everything the parkable rule decides
	// hangs on `activeLeafMessageId`, and reading it ahead of an unbounded network
	// await means judging a leaf that may have moved since — a background draw
	// finishing in that gap advances the leaf and clears its registry entry, so a
	// stale snapshot passes the in-flight check AND skips the rewind branch
	// entirely, parking the marker on a message that is no longer the leaf. The
	// comparison would then never recover: `getFanoutRecoveryState` bails on
	// `parent !== activeLeafMessageId`.
	const meta = requireFound(
		getConversationMeta(params.id, locals.user.id),
		'Conversation not found',
	);
	const source = getMessage(params.id, body.sourceMessageId);
	if (!source) error(404, 'Message not found');
	// Mirrors ../pick, and makes an assertion elsewhere true rather than
	// aspirational: `getFanoutRecoveryState` reports its `avatar` flag from this
	// anchor's role, on the stated grounds that "the avatar route only ever
	// anchors on an assistant message". Nothing enforced that. A user anchor would
	// come back from recovery as an ordinary turn fan-out — a grid that renders no
	// pick action at all, since the page wires `onPick` only for `isAvatar`.
	if (source.role !== 'assistant') {
		error(400, 'An avatar comparison must anchor on an assistant message');
	}

	// Not while a background draw is still running on this description. That draw
	// advances the leaf to its own portrait under a compare-and-swap guard —
	// "only if the leaf is STILL source.id" — which parking here would rewind the
	// leaf back onto, re-satisfying a guard that was about to fail. It would then
	// take the leaf off the description this comparison just parked on (so the
	// grid vanishes from recovery, its portraits stranded as orphan siblings) AND
	// apply a face the user never chose. The tab that started the draw disables
	// the Draw action for its duration; this is the backstop for every other tab.
	if (getAvatarDrawSince(params.id) !== null) {
		error(409, 'An avatar is already being drawn here — wait for it to finish.');
	}

	const leaf = meta.activeLeafMessageId;
	if (leaf && leaf !== source.id) {
		const leafMessage = getMessage(params.id, leaf);
		// Assistant-only, and that conjunct is the whole safety argument. Rewinding
		// the leaf is harmless because what it hides comes straight back as a grid
		// column — but the grid is seeded from `getSiblingAssistants`, which filters
		// by role. A childless USER message satisfies the other two conditions and
		// does NOT come back: a send stopped while queued at the endpoint gate
		// persists the user row and never writes an assistant reply, leaving exactly
		// that shape. Parking over it would drop the message the user typed out of
		// the thread with no column to find it in — and with nothing else under the
		// description, no ‹N/M› arrow to reach it by either.
		//
		// That window is wider here than it looks: a background avatar draw holds
		// the endpoint slot while deliberately leaving the composer live, so on a
		// single-GPU box the next send queues at the gate, which is precisely where
		// Stop leaves no assistant row.
		const parkable =
			leafMessage?.role === 'assistant' &&
			leafMessage.parentMessageId === source.id &&
			!hasChildMessages(params.id, leaf);
		if (!parkable) {
			error(
				409,
				'This conversation has moved on past that message — draw with a single model instead.',
			);
		}
	}
	// One statement for both columns — see `setFanoutParent`'s flag. Split in two,
	// a failure between them leaves the leaf rewound with no marker parked.
	setFanoutParent(params.id, locals.user.id, source.id, leaf !== source.id);

	const response: PrepareAvatarDrawResponse = {
		siblings: getSiblingAssistants(params.id, source.id),
	};
	return json(response);
};
