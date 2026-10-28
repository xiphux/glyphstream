import { error } from '@sveltejs/kit';
import { requireUser } from '#lib/server/auth/guard.js';
import { optionalString, parseJsonBody, requireMaxLength } from '#lib/server/http.js';
import { MAX_PROMPT_CHARS } from '#lib/server/text-limits.js';
import {
	createConversation,
	listConversationIds,
	listConversations,
} from '#lib/server/db/queries/conversations.js';
import { getCustomModelForUser } from '#lib/server/db/queries/custom-models.js';
import { getEndpoint } from '#lib/server/endpoints/registry.js';
import { filterFullyQueued, filterInFlight } from '#lib/server/streaming/in-flight.js';
import { parseModelId } from '#lib/server/endpoints/model-id.js';
import { isModelKind, MAX_CONVERSATION_TITLE_LENGTH } from '#lib/types/api.js';
import type {
	CreateConversationRequest,
	CustomModelParameters,
	GeneratingConversationsResponse,
	ModelKind,
	ReplyStyle,
} from '#lib/types/api.js';
import { validateDisabledFeaturesOrThrow400 } from '#lib/server/util/validate-features.js';
import type { RequestHandler } from './$types';
import { recordModelEvent } from '#lib/server/stats/model-stats.js';

export const GET: RequestHandler = ({ locals, url }) => {
	requireUser(locals);

	// Generating-dot poll (`?generating=1`): the sidebar only needs to know which
	// of the user's conversations still have a generation in flight, so it can
	// drop the dot on the ones that have finished. Returns bare ids — no titles,
	// no timestamps — because that's all the caller reconciles against, and this
	// runs on an interval for as long as a dot is showing. Same
	// cheap-variant-of-an-existing-endpoint shape as `[id]`'s `?fanout=1`.
	//
	// `queuedIds` is the subset that hasn't started — every branch still behind
	// the endpoint's concurrency gate. It rides along rather than getting its own
	// endpoint because it's the same registry walk over the same list, and
	// because this poll is the ONLY thing that ever observes a queued
	// conversation reaching the front of the line: nothing client-side is
	// listening to a generation the user navigated away from.
	if (url.searchParams.get('generating') === '1') {
		const ids = filterInFlight(listConversationIds(locals.user.id));
		const body: GeneratingConversationsResponse = { ids, queuedIds: filterFullyQueued(ids) };
		return Response.json(body);
	}

	return Response.json({ conversations: listConversations(locals.user.id) });
};

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<CreateConversationRequest>(request);

	// Resolve custom model first if supplied — its base endpoint/model wins
	// over any modelId in the body. Snapshot the system prompt + parameters
	// onto the conversation so future edits to the preset don't retroactively
	// change in-flight chats.
	let resolvedEndpointId: string;
	let resolvedModelId: string;
	let resolvedModelKind: ModelKind | null = null;
	let resolvedSystemPrompt: string | null;
	let resolvedParameters: CustomModelParameters | null = null;
	let resolvedCustomModelId: string | null = null;
	let resolvedReplyStyle: ReplyStyle = 'standard';
	let resolvedCheckIns = false;

	let resolvedPhotos = false;

	// modelKind is optional and validated identically whether a custom
	// model or a base model id was supplied — the caller forwards it so
	// the send dispatcher knows the chat/image/video path without
	// re-fetching upstream /v1/models. Resolve it once here.
	if (body.modelKind !== undefined) {
		if (!isModelKind(body.modelKind)) {
			error(400, `Invalid modelKind "${String(body.modelKind)}"`);
		}
		resolvedModelKind = body.modelKind;
	}

	const customModelId = optionalString(body.customModelId, 'customModelId');
	if (customModelId) {
		const cm = getCustomModelForUser(customModelId, locals.user.id);
		if (!cm) error(400, `Unknown custom model "${customModelId}"`);
		if (!getEndpoint(cm.baseEndpointId)) {
			error(
				400,
				`Custom model references unknown endpoint "${cm.baseEndpointId}" — has it been removed from config.toml?`,
			);
		}
		resolvedEndpointId = cm.baseEndpointId;
		resolvedModelId = `${cm.baseEndpointId}::${cm.baseModelId}`;
		resolvedSystemPrompt = cm.systemPrompt;
		resolvedParameters = cm.parameters;
		resolvedCustomModelId = cm.id;
		resolvedReplyStyle = cm.replyStyle;
		resolvedCheckIns = cm.checkIns;
		resolvedPhotos = cm.photos;
	} else {
		const modelId = optionalString(body.modelId, 'modelId')?.trim();
		if (!modelId) error(400, "'modelId' or 'customModelId' is required");

		const parsed = parseModelId(modelId);
		if (!parsed) {
			error(400, `Malformed model id "${modelId}" — must be "{endpoint_id}::{upstream_id}"`);
		}
		if (!getEndpoint(parsed.endpointId)) {
			error(400, `Unknown endpoint "${parsed.endpointId}" — not in config.toml`);
		}
		resolvedEndpointId = parsed.endpointId;
		resolvedModelId = modelId;
		// Snapshot only an explicit body-provided system prompt. The
		// prefs-derived persona (name / aboutYou / customInstructions) is
		// composed at request time in the messages handler — gated by the
		// `personalization` opt-out — so flipping the toggle mid-chat
		// takes effect immediately and pref edits propagate to existing
		// chats. The custom-model branch above still snapshots from the
		// preset because preset edits are explicitly meant not to
		// retroactively change in-flight chats.
		const explicit = requireMaxLength(
			optionalString(body.systemPrompt, 'systemPrompt'),
			'systemPrompt',
			MAX_PROMPT_CHARS,
		)?.trim();
		resolvedSystemPrompt = explicit || null;
	}

	const disabledFeatures = validateDisabledFeaturesOrThrow400(body.disabledFeatures);
	// Validate strictly (like disabledFeatures) rather than silently coercing —
	// e.g. a `{"private": 1}` typo should 400, not quietly create a non-private chat.
	if (body.private !== undefined && typeof body.private !== 'boolean') {
		error(400, "'private' must be a boolean");
	}

	const conv = createConversation({
		userId: locals.user.id,
		endpointId: resolvedEndpointId,
		modelId: resolvedModelId,
		modelKind: resolvedModelKind,
		systemPrompt: resolvedSystemPrompt,
		parameters: resolvedParameters,
		customModelId: resolvedCustomModelId,
		replyStyle: resolvedReplyStyle,
		checkIns: resolvedCheckIns,
		photos: resolvedPhotos,
		title:
			requireMaxLength(
				optionalString(body.title, 'title')?.trim(),
				'title',
				MAX_CONVERSATION_TITLE_LENGTH,
			) || null,
		disabledFeatures,
		// "Private chat" content seal — create-time only, never mutable via PATCH.
		private: body.private ?? false,
	});
	// Counted against the base model, so a preset's use sits with the model it
	// costs disk for, and the page can still tell whether the preset is used.
	if (resolvedCustomModelId) {
		recordModelEvent(resolvedModelId, `preset_chat:${resolvedCustomModelId}`);
	}
	return Response.json({ conversation: conv }, { status: 201 });
};
