import { json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { cancelInFlightGenerations } from '$lib/server/streaming/cancel';
import type { RequestHandler } from './$types';

/**
 * Stop the in-flight generation(s) for this conversation. Idempotent —
 * calling with nothing in flight is a no-op (the user clicked Stop too late
 * or after the stream already ended).
 *
 * Stop halts the whole fan-out; see `cancelInFlightGenerations` for what that
 * means per branch.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);

	// Verify ownership of the conversation before letting anyone cancel it.
	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');

	// Nothing in flight is not an error — succeed silently so the client UI can
	// stay simple.
	return json({ cancelled: await cancelInFlightGenerations(params.id) });
};
