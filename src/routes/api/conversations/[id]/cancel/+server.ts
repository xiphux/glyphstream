import { json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { videoCancel } from '$lib/server/endpoints/client';
import { getInFlightEntries } from '$lib/server/streaming/in-flight';
import type { RequestHandler } from './$types';

/**
 * Stop the in-flight generation(s) for this conversation. Idempotent —
 * calling with nothing in flight is a no-op (the user clicked Stop too late
 * or after the stream already ended).
 *
 * A plain send has one in-flight entry; a multi-model fan-out has N (one per
 * branch). Stop halts the whole fan-out: every entry's AbortController is
 * aborted, and any video branch also gets a bridge-side DELETE /v1/videos/{id}
 * so the runner releases its slot instead of finishing the workflow.
 *
 * For chat / image the abort makes the upstream fetch error; the recorder
 * branch (chat) commits whatever partial text it had.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);

	// Verify ownership of the conversation before letting anyone cancel it.
	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');

	const entries = getInFlightEntries(params.id);
	if (entries.length === 0) {
		// Nothing to cancel — succeed silently so the client UI can stay simple.
		return json({ cancelled: false });
	}

	for (const entry of entries) {
		if (entry.videoJobId) {
			// Best-effort bridge-side cancel; releases the bridge runner slot.
			await videoCancel(entry.endpoint, entry.videoJobId);
		}
		entry.controller.abort();
	}

	return json({ cancelled: true });
};
