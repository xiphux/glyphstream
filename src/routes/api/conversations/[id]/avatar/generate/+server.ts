/**
 * POST /api/conversations/:id/avatar/generate
 *
 * Step two of avatar generation: take an assistant message's appearance
 * description, run it through an image model, and hang the portrait under that
 * description.
 *
 * Why this isn't the normal messages route. That route generates from the USER
 * message it just created and parents the result there; this generates from an
 * assistant message that already exists and parents the result to it. Same
 * relay underneath, different anchor — `startImageRelay` takes the anchor as
 * `userMessage`, and passing the description message is what puts the portrait
 * directly beneath it, where `computeMergeFlags` fuses the two into one bubble.
 *
 * The model is chosen per generation and never written back to the
 * conversation: an avatar is a side errand, not a decision to switch the chat
 * to an image model. That's the same transient-override rule a fan-out branch
 * follows, reached without needing the fan-out machinery.
 *
 * The portrait persists as `displayOnly` — see the flag's note. The client sets
 * it as the conversation's avatar once `done` lands; doing it there rather than
 * in the relay keeps the generation and the (already existing) avatar endpoint
 * independent, and a disconnect mid-generation degrades to "the portrait is in
 * the thread, set it from the lightbox" rather than a half-applied write.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { getConversationMeta } from '$lib/server/db/queries/conversations';
import { getMessage } from '$lib/server/db/queries/messages';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { parseModelId } from '$lib/server/endpoints/model-id';
import { listAllModels } from '$lib/server/endpoints/list-models';
import type { ModelEntry } from '$lib/types/api';
import { startImageRelay } from '$lib/server/streaming/image-relay';
import { clearInFlight, registerInFlight } from '$lib/server/streaming/in-flight';
import { sseResponse } from '$lib/server/streaming/sse-transport';
import { partsToText } from '$lib/message-parts';
import type { RequestHandler } from './$types';

interface GenerateAvatarBody {
	/** The assistant message whose text is the appearance description. */
	sourceMessageId?: unknown;
	/** Composite `endpoint::model` of the image model to draw with. */
	modelId?: unknown;
}

export const POST: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<GenerateAvatarBody>(request);
	if (typeof body.sourceMessageId !== 'string' || !body.sourceMessageId) {
		error(400, "'sourceMessageId' is required");
	}
	if (typeof body.modelId !== 'string' || !body.modelId) {
		error(400, "'modelId' is required");
	}

	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) error(404, 'Conversation not found');

	// Scoped to this conversation, so a message id from someone else's thread
	// can't be used to seed a generation here.
	const source = getMessage(params.id, body.sourceMessageId);
	if (!source) error(404, 'Message not found');

	const prompt = partsToText(source.parts).trim();
	if (!prompt) error(400, 'That message has no text to draw from');

	const parsed = parseModelId(body.modelId);
	const endpoint = parsed ? getEndpoint(parsed.endpointId) : null;
	if (!parsed || !endpoint) error(400, `Unknown model "${body.modelId}"`);

	// Must actually be an image model — a chat model asked to draw returns prose
	// the persister would then try to store as bytes. Unknown ids (endpoint
	// reachable but its model list unavailable) are let through: the upstream
	// call is the backstop, same as the messages route.
	const modelEntry = (await listAllModels()).find((m: ModelEntry) => m.id === body.modelId);
	if (modelEntry && modelEntry.kind !== 'image') {
		error(400, `"${body.modelId}" is not an image model`);
	}

	const inFlight = registerInFlight(params.id, endpoint, undefined, 'image', body.modelId, null);
	const onComplete = () => clearInFlight(params.id, inFlight);

	const stream = startImageRelay({
		conversationId: params.id,
		userId: locals.user.id,
		conversationTitle: meta.title,
		endpoint,
		// Recorded as this row's `modelUsed`: the portrait was drawn by the image
		// model, not by the conversation's. The row merges into the description's
		// bubble, so this never surfaces as a mismatched label.
		storedModelId: body.modelId,
		upstreamModelId: parsed.upstreamId,
		prompt,
		// The anchor: the portrait is appended as this message's child.
		userMessage: source,
		dispatchMediaIds: [],
		sourceMediaId: null,
		// The description is prose, not a formatted image prompt, so the enhancer
		// earns its keep here more than anywhere: it restyles into whatever this
		// model prefers. Honors the conversation's own toggle.
		promptStyle: modelEntry?.promptStyle ?? null,
		promptHint: modelEntry?.promptHint ?? null,
		enhancementEnabled: !meta.disabledFeatures.includes('image_prompt_enhancement'),
		displayOnly: true,
		abortSignal: inFlight.controller.signal,
		advanceActiveLeaf: true,
		// The conversation already has a title by now (it has a description turn
		// in it), and an avatar is a side errand — not the thing to name the
		// thread after.
		suppressTitleTask: true,
		onStarted: () => {
			inFlight.generationStartedAt = Date.now();
		},
		onGenerationSettled: onComplete,
		onComplete,
	});
	return sseResponse(stream);
};
