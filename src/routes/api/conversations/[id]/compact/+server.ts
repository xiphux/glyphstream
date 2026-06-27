import { error, json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { runCompaction } from '$lib/server/chat/compaction';
import { formatUpstreamError, UpstreamError } from '$lib/server/endpoints/client';
import type { RequestHandler } from './$types';

/**
 * Manual "Compact conversation" action. Summarizes the older history through
 * the conversation's own model and appends the summary; the client
 * `invalidateAll()`s to pick up the re-rendered thread. Auto-compaction reuses
 * the same `runCompaction` engine just-in-time inside the send handler.
 */
export const POST: RequestHandler = async ({ locals, params }) => {
	requireUser(locals);
	// Ownership scope (the multi-user isolation invariant) before any work.
	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');

	try {
		const result = await runCompaction(params.id, locals.user.id);
		if (result.status === 'noop') {
			throw error(409, 'Not enough conversation history to compact yet.');
		}
		return json({ ok: true, summaryMessageId: result.summaryMessageId });
	} catch (e) {
		if (e instanceof UpstreamError) {
			throw error(502, formatUpstreamError(e));
		}
		throw e;
	}
};
