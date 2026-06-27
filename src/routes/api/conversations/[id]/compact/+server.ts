import { error, json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { getConversationMeta, getFanoutParent } from '$lib/server/db/queries/conversations';
import { prepareCompaction, runCompaction } from '$lib/server/chat/compaction';
import { streamCompaction } from '$lib/server/streaming/compaction-relay';
import { sseResponse } from '$lib/server/streaming/sse-transport';
import { formatUpstreamError, UpstreamError } from '$lib/server/endpoints/client';
import type { RequestHandler } from './$types';

/**
 * Compact a conversation: summarize the older history through the
 * conversation's own model and append the summary.
 *
 * `?stream=1` streams the summary token-by-token (SSE) so the user gets live
 * feedback, settling into the persisted collapsed divider on `compaction_done`.
 * Without it, a blocking call returns JSON. Both the manual "Compact" button and
 * client-driven auto-compaction (`maybeAutoCompact`, before a send) call this
 * same endpoint — there is no server-side auto path in the send handler.
 */
export const POST: RequestHandler = async ({ locals, params, request, url }) => {
	requireUser(locals);
	// Ownership scope (the multi-user isolation invariant) before any work.
	requireFound(getConversationMeta(params.id, locals.user.id), 'Conversation not found');

	// Refuse while a fan-out comparison is parked: compaction advances the active
	// leaf, which clears the parked fan-out marker and drops the compare grid. The
	// client also disables the button, but this guards the API directly.
	if (getFanoutParent(params.id, locals.user.id)) {
		throw error(409, 'Finish or dismiss the model comparison before compacting.');
	}

	if (url.searchParams.get('stream') === '1') {
		// Plan first (cheap, no model call) so "nothing to compact" is a clean
		// 409 rather than an SSE error frame after the stream has opened.
		const plan = await prepareCompaction(params.id, locals.user.id);
		if (!plan) throw error(409, 'Not enough conversation history to compact yet.');
		return sseResponse(
			streamCompaction({ conversationId: params.id, plan, abortSignal: request.signal }),
		);
	}

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
