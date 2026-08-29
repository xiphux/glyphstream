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
 * The portrait persists as `displayOnly` — see the flag's note — and becomes the
 * conversation's avatar HERE, via the relay's `onMediaPersisted` hook, in the
 * same breath as the row that holds it.
 *
 * TWO MODES, and the split is the whole design. One model is a side errand: it
 * runs in the background under a stable registry key, the composer stays live
 * throughout, and the portrait becomes the face the moment it persists. Two or
 * more is a comparison — the user has said, by picking a second model, that they
 * want to choose — so those branches take per-branch keys (they must not abort
 * each other), count as turns (the recovered grid's placeholder columns come
 * from `conversationTurnEntries`), leave the leaf parked at the description, and
 * apply NOTHING on arrival. The pick applies, via ../pick.
 *
 * Where a comparison is ALLOWED to park, and the seed of portraits it starts
 * from, are ../prepare's business — decided once, before any branch, the way
 * .../messages/prepare decides them for a turn fan-out. A branch request only
 * streams.
 *
 * It used to be the client that applied it, on `done`, on the theory that a
 * disconnect mid-generation degrades to "the portrait is in the thread, set it
 * from the lightbox". In practice that theory had the failure backwards. iOS
 * suspends a PWA seconds after the screen locks, killing the fetch — and a draw
 * on a shared GPU takes minutes, so putting the phone down during one is the
 * NORMAL way to use this, not an edge case. What the user got was a portrait
 * sitting in the thread, no avatar, and a "Load failed" toast for a generation
 * that had in fact succeeded. The relay already outlives the client connection
 * by design; the apply now does too.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	getConversationMeta,
	getFanoutParent,
	setConversationAvatar,
} from '$lib/server/db/queries/conversations';
import { getMessage } from '$lib/server/db/queries/messages';
import { notifyFanoutCompleteIfLast } from '$lib/server/messages/fanout-notify';
import { generateId } from '$lib/server/util/id';
import { getEndpoint } from '$lib/server/endpoints/registry';
import { parseModelId } from '$lib/server/endpoints/model-id';
import { listAllModels } from '$lib/server/endpoints/list-models';
import type { ModelEntry } from '$lib/types/api';
import { startImageRelay } from '$lib/server/streaming/image-relay';
import {
	AVATAR_BRANCH,
	clearInFlight,
	conversationFanoutAtCapacity,
	registerInFlight,
} from '$lib/server/streaming/in-flight';
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
	 * Draw as one branch of a multi-model comparison rather than as the
	 * conversation's next face.
	 *
	 * Flips three things that only make sense one way or the other, never a mix
	 * (see the module docblock): the registry key, whether the portrait is
	 * applied on arrival, and where the active leaf ends up.
	 */
	fanout?: unknown;
	/** How many branches this comparison dispatched, for the single aggregate
	 *  "N ready" notification. Ignored unless `fanout`. */
	fanoutSize?: unknown;
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

	// One branch of a comparison. ../prepare has already parked the fan-out on
	// this same message and vetted that it may be parked there, exactly as
	// .../messages/prepare does for a turn fan-out — a branch request doesn't
	// re-decide it, it just streams.
	const isFanout = body.fanout === true;
	// …but "doesn't re-decide it" is not the same as "trusts anything". These are
	// two independent HTTP requests, so a branch can arrive without a prepare ever
	// having run. The anchor's role is the one part worth re-checking: it is what
	// `getFanoutRecoveryState` reads its `avatar` flag from, and a portrait hung
	// under a user message would be a comparison that recovery reports as an
	// ordinary turn fan-out. Cheap, and it makes ../prepare's guard hold for the
	// route that actually creates the rows.
	if (isFanout && source.role !== 'assistant') {
		error(400, 'An avatar comparison must anchor on an assistant message');
	}
	// Same ceiling as a chat/media fan-out, and the same reasoning: every branch
	// holds an SSE connection, a registry entry and a queued waiter, so an
	// unbounded fan-out is a resource-exhaustion vector even though the
	// per-endpoint gate throttles the actual upstream calls. The check and
	// `registerInFlight` run synchronously back-to-back, so concurrent branch
	// POSTs can't race past it.
	if (isFanout && conversationFanoutAtCapacity(params.id)) {
		error(429, 'Too many concurrent generations for this conversation');
	}

	// The mirror of ../prepare's refusal, seen from the other side. A parked
	// comparison pins the leaf AT its anchor — which is exactly the state this
	// draw's compare-and-swap reads as "nothing has happened since, safe to
	// advance". So the CAS succeeds precisely where the most has happened:
	// appendMessage moves the leaf off the description and nulls the marker in the
	// same statement, the grid drops out of recovery (`parent !== activeLeaf`), its
	// candidates strand as siblings, and `onMediaPersisted` applies a face nobody
	// picked.
	//
	// Keyed on THIS anchor, not on "any parked fan-out". An ordinary turn fan-out
	// parks on a user message, while the avatar anchor is the last assistant reply
	// — different ids, so the CAS fails harmlessly and the draw is exactly what was
	// asked for. Refusing there would block a legitimate side errand.
	//
	// This window is worse than the one ../prepare guards, not better: a settled
	// comparison awaiting a pick leaves no registry entry and no running poll
	// (`getAvatarDrawSince` reads only AVATAR_BRANCH, which a comparison never
	// uses), so a tab that went stale before it was parked never learns of it. That
	// lasts as long as the comparison goes unresolved rather than as long as a
	// generation runs. Refusing is also what repairs it: the 409 rides
	// reportFailure → reconcile → invalidateAll, so that tab is told why AND shown
	// the comparison it didn't know about.
	//
	// Read here rather than earlier so it stays synchronous with registerInFlight
	// below; before `await listAllModels()` it would open a real TOCTOU window.
	if (!isFanout && getFanoutParent(params.id, locals.user.id) === source.id) {
		error(409, 'A portrait comparison is open here — pick one or dismiss it first.');
	}

	const inFlight = registerInFlight(
		params.id,
		endpoint,
		// A comparison's branches must coexist; a background draw supersedes its
		// predecessor. Both fall out of the key.
		isFanout ? generateId() : AVATAR_BRANCH,
		'image',
		body.modelId,
		null,
		// A background draw is not a turn: the recovery poll, the fan-out grid and
		// the aggregate notification must not count it as one of the conversation's
		// branches. A comparison's branches ARE turns — they're what the grid is
		// made of, and the aggregate notify waits on exactly this set.
		isFanout,
	);
	const fanoutSize = typeof body.fanoutSize === 'number' ? body.fanoutSize : undefined;
	const onComplete = () => {
		clearInFlight(params.id, inFlight);
		if (isFanout) {
			notifyFanoutCompleteIfLast({
				conversationId: params.id,
				userId: locals.user.id,
				userMessageId: source.id,
				conversationTitle: meta.title,
				modality: 'image',
				fanoutSize,
			});
		}
	};

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
		// A comparison leaves the leaf where it parked it: every branch is a
		// sibling of the others and none of them wins by landing first — the pick
		// moves the leaf. A background draw advances to its portrait…
		advanceActiveLeaf: !isFanout,
		// …but only if the branch hasn't moved on. A draw takes minutes and the
		// composer stays live throughout (that's the point of backgrounding it),
		// so the user may well have sent another turn by the time the portrait
		// lands. Without this guard the leaf snaps back to the description and
		// that exchange drops out of the thread. If the guard fails the portrait
		// still persists as a sibling, reachable by the ‹N/M› arrows.
		advanceActiveLeafIfCurrent: source.id,
		// Every branch of a comparison would otherwise buzz on its own; the single
		// aggregate "N ready" fires from the last one's onComplete instead.
		suppressNotify: isFanout,
		// The conversation already has a title by now (it has a description turn
		// in it), and an avatar is a side errand — not the thing to name the
		// thread after.
		suppressTitleTask: true,
		onStarted: () => {
			inFlight.generationStartedAt = Date.now();
		},
		// The whole point of a background draw, and unconditional there. A second
		// draw started since supersedes this one at the registry (they share
		// AVATAR_BRANCH) and aborts it, so in the ordinary case a superseded draw
		// never reaches here at all; if it squeaked past the abort it applies first
		// and loses to the newer one, which is the order the user pressed the
		// buttons in either way.
		//
		// A comparison applies nothing: three portraits racing to be the face
		// would repaint the header at each model's finishing time and settle on
		// whichever GPU was slowest. The pick applies, at ../pick.
		onMediaPersisted: isFanout
			? undefined
			: (mediaId) => {
					const result = setConversationAvatar(params.id, locals.user.id, mediaId);
					// Both reasons are unreachable-in-practice races (the conversation
					// deleted, or the media reaped, between persist and now) — worth a line
					// in the log, not worth failing a generation that otherwise worked.
					if (!result.ok) {
						console.warn(`[avatar] could not apply portrait to ${params.id}: ${result.reason}`);
					}
				},
		// Free the registry slot as soon as the GENERATION settles — the entry
		// means "a generation is running", and past `done` none is. Deliberately
		// NOT the same function as `onComplete`: `notifyFanoutCompleteIfLast` infers
		// "last branch" from the registry going empty, and it has to make that check
		// at stream close, a microtask after the clear, rather than in the same
		// breath as it. See fanout-notify.ts for why that gap is what keeps the
		// aggregate exactly-once.
		onGenerationSettled: () => clearInFlight(params.id, inFlight),
		onComplete,
	});
	return sseResponse(stream);
};
