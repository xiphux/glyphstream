/**
 * POST /api/conversations/:id/messages/prepare
 *
 * Creates the shared user message for a multi-model fan-out WITHOUT
 * dispatching any generation. The client then fires N branch requests at
 * `.../messages` (each `fanoutBranch: true`, parented to the returned
 * message id) which stream concurrently into sibling assistant responses.
 *
 * Splitting "create the user message once" out of the per-branch requests
 * avoids N parallel POSTs racing to each create their own user message.
 * Normal append already lands the conversation's active_leaf on this user
 * message, which is exactly where it must stay pinned while the branches run
 * (so every branch serializes the identical history and the unpicked
 * siblings remain reachable until the user picks one).
 *
 * Because the branches suppress their own title task (N of them would each
 * fire one against the same first exchange), the title task is started here
 * once, fire-and-forget — its result lands via the post-fan-out refetch.
 */

import { json, error } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { getConversationMeta, setFanoutParent } from '$lib/server/db/queries/conversations';
import { createUserMessage } from '$lib/server/messages/create-user-message';
import { startTitleTaskIfFirstExchange } from '$lib/server/tasks/title-task-runner';
import type { ChatMessage, PrepareFanoutRequest, PrepareFanoutResponse } from '$lib/types/api';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);

	const meta = requireFound(
		getConversationMeta(params.id, locals.user.id),
		'Conversation not found',
	);

	const body = await parseJsonBody<PrepareFanoutRequest>(request);
	const text = body.text?.trim() ?? '';
	const attachedMediaIds = Array.isArray(body.attachedMediaIds)
		? body.attachedMediaIds.filter((s): s is string => typeof s === 'string')
		: [];
	if (!text && attachedMediaIds.length === 0) {
		throw error(400, "'text' or 'attachedMediaIds' is required");
	}

	const userMessage = createUserMessage({
		conversationId: params.id,
		userId: locals.user.id,
		text,
		attachedMediaIds,
		editedMessageId: body.editedMessageId,
		parentMessageId: body.parentMessageId,
		activeLeafMessageId: meta.activeLeafMessageId ?? null,
		existingTitle: meta.title,
	});

	// Mark the conversation as having an unresolved fan-out parked on this user
	// message, so a reload mid-comparison can rehydrate the compare grid
	// (cleared when the user picks / dismisses, via selectBranch).
	setFanoutParent(params.id, userMessage.id);

	// Title generation runs once for the whole fan-out (branches suppress it).
	// Fire-and-forget: the new title surfaces on the client's post-fan-out
	// invalidate, not via this response.
	void startTitleTaskIfFirstExchange(params.id);

	const response: PrepareFanoutResponse = { userMessage: userMessage as ChatMessage };
	return json(response);
};
