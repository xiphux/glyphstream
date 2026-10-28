/**
 * POST /api/conversations/:id/photos
 *
 * Develop one of a reply's `[photo: …]` (in a chat whose preset sends photos):
 * draw it with an image model and keep the result as a version of that photo,
 * on the reply itself (see `message_images`). Streams the generation's events,
 * like any draw.
 *
 * Nothing in the thread changes — no message is added and the leaf stays
 * where it is — so a photo can be developed whenever the reply is on screen:
 * after the conversation moved on, or while another reply is still streaming.
 * The image is never sent upstream; the model already has its description.
 *
 * A comparison is just several of these, sharing an id (`compare`): every
 * result is kept as a version, the first to land goes on show unless one
 * already is, and the user picks with PATCH ./[photoId]. They notify once,
 * together.
 *
 * The model is chosen per draw and never written back to the conversation,
 * the same transient-override rule a portrait follows.
 *
 * GET ?messages=a,b,… is those replies' photo state: their versions and the
 * draws still out (`PhotoStateResponse`). The page patches its copies of the
 * replies with it after a photo changes, rather than reloading — a reply above
 * the window it reloads would otherwise never see the change. It's also what
 * the page watches while a photo is developing, so one that lands after the
 * page lost its stream (a suspended PWA, a reload mid-draw) still shows up.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { parseJsonBody } from '#lib/server/http.js';
import { getConversationMeta } from '#lib/server/db/queries/conversations.js';
import { getMessage, photoStateFor } from '#lib/server/db/queries/messages.js';
import { clearImageFailures } from '#lib/server/db/queries/message-images.js';
import { getEndpoint } from '#lib/server/endpoints/registry.js';
import { parseModelId } from '#lib/server/endpoints/model-id.js';
import { listAllModels } from '#lib/server/endpoints/list-models.js';
import { submitGenerationJob } from '#lib/server/generation/jobs.js';
import { enforceGenerationCap } from '#lib/server/generation/user-cap.js';
import { resolveDisabledFeatures } from '#lib/server/chat/private-seal.js';
import { sseResponse } from '#lib/server/streaming/sse-transport.js';
import { photoDrawsInFlight } from '#lib/server/streaming/in-flight.js';
import { nearestOffered } from '#lib/aspect-ratio.js';
import { MAX_FANOUT_BRANCHES_PER_CONVERSATION } from '#lib/fanout.js';
import { photoMarkers } from '#lib/texting-photos.js';
import type { ModelEntry, PhotoStateResponse } from '#lib/types/api.js';
import type { RequestHandler } from './$types';

interface DevelopPhotoBody {
	/** The reply that wrote the `[photo: …]`. */
	messageId?: unknown;
	/** Which of its photos, as `textingItems` numbers them. */
	index?: unknown;
	/** Composite `endpoint::model` of the image model to draw with. */
	modelId?: unknown;
	/** What to draw — the description, as the user left it in the dialog.
	 *  Omitted (or blank) draws the description as written. */
	prompt?: unknown;
	/** May only turn the image-prompt enhancer off — see the portrait route. */
	enhance?: unknown;
	/** The photo's shape, `W:H`; the nearest the model offers is used. */
	aspectRatio?: unknown;
	/** One draw of a comparison: an id its draws share, made up by the client.
	 *  Only ever matched against versions of this same reply. */
	compare?: unknown;
}

/** The most replies one status check may ask about — a page window's worth. */
const MAX_WATCHED = 200;

export const GET: RequestHandler = ({ locals, params, url }) => {
	requireUser(locals);
	if (!getConversationMeta(params.id, locals.user.id)) error(404, 'Conversation not found');
	const ids = (url.searchParams.get('messages') ?? '').split(',').filter(Boolean);
	if (ids.length > MAX_WATCHED) error(400, 'Too many messages');
	const state = photoStateFor(params.id, ids);
	const body: PhotoStateResponse = { developing: 0, replies: {} };
	for (const [id, entry] of state) {
		body.replies[id] = entry;
		body.developing += entry.developing.length;
	}
	return Response.json(body);
};

export const POST: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	// Opt-in per-user cap (config `[limits]`), before anything is persisted.
	enforceGenerationCap(locals.user);

	const body = await parseJsonBody<DevelopPhotoBody>(request);
	if (typeof body.messageId !== 'string' || !body.messageId) {
		error(400, "'messageId' is required");
	}
	if (typeof body.index !== 'number' || !Number.isInteger(body.index) || body.index < 0) {
		error(400, "'index' must be a photo's number");
	}
	if (typeof body.modelId !== 'string' || !body.modelId) {
		error(400, "'modelId' is required");
	}
	const compareId = body.compare;
	if (
		compareId !== undefined &&
		(typeof compareId !== 'string' || !/^[\w-]{1,64}$/.test(compareId))
	) {
		error(400, "'compare' must be an id");
	}

	const meta = getConversationMeta(params.id, locals.user.id);
	if (!meta) error(404, 'Conversation not found');
	// Scoped to this conversation, so a message from someone else's thread can't
	// be given a photo here.
	const reply = getMessage(params.id, body.messageId);
	if (!reply || reply.role !== 'assistant') error(404, 'Reply not found');
	// The chat's preset decides whether it sends photos; one that doesn't has
	// nothing here to develop, whatever text looks like a marker.
	if (!meta.photos) error(409, "This chat doesn't send photos");
	// The marker has to be there: the version is stored against its number.
	// (Speakers don't change the numbering, so the preset's name isn't needed.)
	const marker = photoMarkers(reply, '').find((m) => m.index === body.index);
	if (!marker) error(404, 'That reply has no such photo');

	const supplied = typeof body.prompt === 'string' ? body.prompt.trim() : '';
	const prompt = supplied || marker.description;

	const parsed = parseModelId(body.modelId);
	const endpoint = parsed ? getEndpoint(parsed.endpointId) : null;
	if (!parsed || !endpoint) error(400, `Unknown model "${body.modelId}"`);
	// A chat model asked to draw returns prose the persister would try to store
	// as bytes. An id the endpoint's list doesn't have is let through: the
	// upstream call is the backstop, as for any draw.
	const modelEntry = (await listAllModels()).find((m: ModelEntry) => m.id === body.modelId);
	if (modelEntry && modelEntry.kind !== 'image') {
		error(400, `"${body.modelId}" is not an image model`);
	}

	// Through the private seal, which a raw read of the column misses — see the
	// portrait route. The client may only turn enhancement off from there.
	const enhancementAllowed = !resolveDisabledFeatures(meta).includes('image_prompt_enhancement');
	const enhancementEnabled =
		enhancementAllowed && (typeof body.enhance !== 'boolean' || body.enhance);

	// Every draw holds a connection, a registry entry and a queued waiter, so
	// bound how many one conversation can have going — the same ceiling a
	// fan-out has, counted separately from it. Synchronous with the job's
	// registration below.
	if (photoDrawsInFlight(params.id) >= MAX_FANOUT_BRANCHES_PER_CONVERSATION) {
		error(429, 'Too many photos developing in this conversation');
	}

	// A new attempt replaces the failed one on screen — except within a
	// comparison, whose failures are among the results it's showing.
	clearImageFailures(reply.id, marker.index, compareId ?? null);

	const stream = submitGenerationJob({
		userId: locals.user.id,
		conversationId: params.id,
		anchorMessageId: reply.id,
		kind: 'image',
		origin: 'photo',
		// The version's model, not the conversation's.
		modelId: body.modelId,
		fanoutIndex: null,
		params: {
			prompt,
			dispatchMediaIds: [],
			sourceMediaId: null,
			aspectRatio: nearestOffered(
				typeof body.aspectRatio === 'string' ? body.aspectRatio : null,
				modelEntry?.aspectRatios ?? [],
			)?.value,
			enhancementEnabled,
			promptStyle: modelEntry?.promptStyle ?? null,
			promptHint: modelEntry?.promptHint ?? null,
			displayOnly: true,
			photo: {
				sourceMessageId: reply.id,
				index: marker.index,
				...(marker.speaker ? { speaker: marker.speaker } : {}),
			},
			...(compareId ? { compareId } : {}),
		},
	});
	return sseResponse(stream);
};
