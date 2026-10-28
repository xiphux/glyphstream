import { requireFound, requireUser } from '#lib/server/auth/guard.js';
import { deleteCheckIn, getCheckIn } from '#lib/server/db/queries/check-ins.js';
import { getConversationMeta } from '#lib/server/db/queries/conversations.js';
import { getCheckInsConfig } from '#lib/server/endpoints/config.js';
import { getInFlightSince } from '#lib/server/streaming/in-flight.js';
import type { CheckInStatus } from '#lib/types/api.js';
import type { RequestHandler } from './$types';

/**
 * The pending check-in and whether a turn is running: the open page's probe
 * while one is due (see `check-in-controller.svelte.ts`), cheap enough to
 * poll where a whole page reload isn't.
 */
export const GET: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const meta = requireFound(
		getConversationMeta(params.id, locals.user.id),
		'Conversation not found',
	);
	const body: CheckInStatus = {
		checkIn:
			meta.checkIns && getCheckInsConfig().enabled ? getCheckIn(params.id, locals.user.id) : null,
		inFlight: getInFlightSince(params.id) !== null,
	};
	return Response.json(body);
};

/**
 * Cancel the conversation's pending check-in. Idempotent — one that
 * already fired (or was never set) is gone either way, so it succeeds quietly.
 */
export const DELETE: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');
	return Response.json({ cancelled: deleteCheckIn(params.id, locals.user.id) });
};
