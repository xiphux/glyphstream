import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { videoCancel } from '$lib/server/endpoints/client';
import { getInFlight } from '$lib/server/streaming/in-flight';
import type { RequestHandler } from './$types';

/**
 * Stop an in-flight generation for this conversation. Idempotent — calling
 * with no in-flight op is a no-op (the user just clicked Stop too late or
 * after the stream already ended).
 *
 * For chat / image: aborts the AbortController; the upstream fetch errors,
 * the recorder branch (chat) commits whatever partial text it had.
 *
 * For video: also issues DELETE /v1/videos/{id} to the bridge so the bridge
 * runner releases its slot instead of running the workflow to completion.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);

	// Verify ownership of the conversation before letting anyone cancel it.
	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) throw error(404, 'Conversation not found');

	const inFlight = getInFlight(params.id);
	if (!inFlight) {
		// Nothing to cancel — succeed silently so the client UI can stay simple.
		return json({ cancelled: false });
	}

	if (inFlight.videoJobId) {
		// Best-effort bridge-side cancel; releases the bridge runner slot.
		await videoCancel(inFlight.endpoint, inFlight.videoJobId);
	}
	inFlight.controller.abort();

	return json({ cancelled: true });
};
