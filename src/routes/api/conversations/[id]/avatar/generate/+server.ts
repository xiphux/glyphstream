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
import { AVATAR_BRANCH, clearInFlight, registerInFlight } from '$lib/server/streaming/in-flight';
import { resolveDisabledFeatures } from '$lib/server/chat/private-seal';
import { sseResponse } from '$lib/server/streaming/sse-transport';
import { partsToText } from '$lib/message-parts';
import type { RequestHandler } from './$types';

interface GenerateAvatarBody {
	/** The assistant message the portrait hangs under. Still required when
	 *  `prompt` is supplied — it's the anchor, not just the text source. */
	sourceMessageId?: unknown;
	/** Composite `endpoint::model` of the image model to draw with. */
	modelId?: unknown;
	/**
	 * The image prompt to draw, when the client has one. Normally the
	 * description extracted from the source message and then reviewed by the
	 * user, so it may differ from that message's text — models that stay in
	 * character tend to wrap the description in prose, and the user gets the
	 * final say either way.
	 *
	 * Omitted (or blank) falls back to the message's full text, which keeps the
	 * endpoint usable on its own and matches what it did before editing existed.
	 */
	prompt?: unknown;
	/**
	 * Whether to run the prompt through the image-prompt enhancer.
	 *
	 * Explicit here because the conversation-level `image_prompt_enhancement`
	 * toggle is kind-scoped to image conversations, so it never renders in the
	 * chat conversation an avatar is drawn from — the client is the only place
	 * the choice can be made. Omitted falls back to the conversation's setting,
	 * which keeps the endpoint honest on its own.
	 */
	enhance?: unknown;
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

	// A supplied prompt wins; the message's own text is the fallback. Whatever
	// is used ends up on the media row as `promptFull`, so the lightbox shows
	// what actually drew the portrait rather than what the model happened to say.
	const supplied = typeof body.prompt === 'string' ? body.prompt.trim() : '';
	const prompt = supplied || partsToText(source.parts).trim();
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

	// Its OWN branch key, not the default one. `registerInFlight` aborts whoever
	// currently holds a key, and the default is what an ordinary send registers
	// under — so sharing it would mean the next chat message the user types kills
	// the drawing, which is precisely the thing this flow backgrounds itself to
	// let them do. A stable key (rather than a fresh id per call, as fan-out
	// uses) also self-limits: starting a second avatar draw supersedes the first,
	// which is the wanted behaviour for a conversation that has one avatar.
	// Through `resolveDisabledFeatures`, not the raw column. A private chat's
	// seal is DERIVED, never persisted — so the stored list doesn't contain
	// `image_prompt_enhancement` and a raw read says "enabled". That category is
	// sealed precisely because the enhancer ships the prompt to a SECOND model on
	// a possibly-third-party endpoint, which is the one thing a private chat
	// promises not to do.
	//
	// The client's flag may only turn enhancement OFF from there, never back on:
	// it's a preference within what the conversation permits, not an override of
	// it.
	const enhancementAllowed = !resolveDisabledFeatures(meta).includes('image_prompt_enhancement');
	const enhancementEnabled =
		enhancementAllowed && (typeof body.enhance !== 'boolean' || body.enhance);

	const inFlight = registerInFlight(
		params.id,
		endpoint,
		AVATAR_BRANCH,
		'image',
		body.modelId,
		null,
		// Not a turn: the recovery poll, the fan-out grid and the aggregate
		// notification must not count this as one of the conversation's branches.
		false,
	);
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
		// model prefers.
		promptStyle: modelEntry?.promptStyle ?? null,
		promptHint: modelEntry?.promptHint ?? null,
		enhancementEnabled,
		displayOnly: true,
		abortSignal: inFlight.controller.signal,
		advanceActiveLeaf: true,
		// …but only if the branch hasn't moved on. A draw takes minutes and the
		// composer stays live throughout (that's the point of backgrounding it),
		// so the user may well have sent another turn by the time the portrait
		// lands. Without this guard the leaf snaps back to the description and
		// that exchange drops out of the thread. If the guard fails the portrait
		// still persists as a sibling, reachable by the ‹N/M› arrows.
		advanceActiveLeafIfCurrent: source.id,
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
