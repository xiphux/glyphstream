import { redirect } from '@sveltejs/kit';
import { CONVERSATION_MISSING_NOTICE } from '$lib/notices';
import { requireUserPage } from '$lib/server/auth/guard';
import { listActiveCanvases } from '$lib/server/db/queries/artifacts';
import { getConversationDetail } from '$lib/server/db/queries/conversations';
import { getCustomModelForUser } from '$lib/server/db/queries/custom-models';
import { friendlyModelName } from '$lib/server/endpoints/friendly-name';
import { parseModelId } from '$lib/server/endpoints/model-id';
import { listAllModelsWithErrors } from '$lib/server/endpoints/list-models';
import { getFanoutRecoveryState } from '$lib/server/messages/fanout-recovery';
import { getAvatarDrawSince, getInFlightSince } from '$lib/server/streaming/in-flight';
import { timeDb } from '$lib/server/util/db-timing';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals, params, url }) => {
	// Deliberately does NOT `await parent()`, diverging from the (app) page-load
	// convention — see `requireUserPage`, which supplies the redirect the parent
	// await was there to order.
	//
	// `await parent()` sets SvelteKit's `uses.parent`, and the client marks a
	// node invalid whenever its parent re-ran. This page returns the entire
	// active branch with `content_html` (5-20x the source text for shiki code
	// blocks), so that coupling made every `invalidate('app:conversations')` —
	// fired on tab refocus, and after each completed turn — re-serialize and
	// re-download the whole conversation to refresh a sidebar title and sort
	// order. Measured at 35 KB for a 40-turn seeded thread and megabytes for a
	// long code-heavy one.
	//
	// Nothing here reads parent data (the old call discarded its result), so
	// dropping it costs nothing and restores the targeted invalidation the
	// layout's `depends('app:conversations')` comment already describes.
	requireUserPage(locals, url);
	const conversation = timeDb(locals, () => getConversationDetail(params.id, locals.user.id));
	// Send the user home rather than 404, and let the new-chat page raise a
	// toast. A 404 here is a dead end in the standalone PWA — no back button,
	// no chrome, nothing to tap — and the most common way to reach one is a
	// stale OS notification for a conversation deleted on another device.
	//
	// The /api/* handlers 404 on an ownership-scoped miss so a non-owner can't
	// confirm a row exists; this diverges deliberately, and safely, because
	// getConversationDetail(id, userId) has already collapsed "gone" and "not
	// yours" into the same null — the redirect discloses nothing the 404 didn't.
	if (!conversation) redirect(302, `/?notice=${CONVERSATION_MISSING_NOTICE}`);

	// Whether a generation is running for this conversation right now,
	// per the server's in-flight registry — the source of truth the
	// chat page uses to restore the "Generating…" indicator after an
	// iOS suspension killed the client's fetch. Unix ms start time, or
	// null when nothing is in flight.
	const inFlightSince = getInFlightSince(params.id);

	// The same question for an avatar draw, which `getInFlightSince` deliberately
	// excludes (it isn't a turn — see the note there). Reported separately so the
	// header ring can come back after a suspension instead of the draw silently
	// becoming invisible for the minutes it has left to run.
	const avatarDrawSince = getAvatarDrawSince(params.id);

	// Friendly identity for the assistant in message bubbles. Custom models
	// win because the user named them; otherwise we strip the verbose
	// "endpoint::owner/model" prefix down to just the recognizable slug.
	//
	// Avatar resolution, most specific first: the conversation's own override,
	// else its preset's, else none. The override is what lets one roleplay
	// preset wear a different face per chat — and, because nothing about it
	// requires a preset, what lets a plain base-model conversation have a face
	// at all. It's a bare media id, not an expanded row: the client turns it
	// into a `/api/media/:id/thumbnail` URL, and this payload is on the
	// critical path for the whole conversation.
	//
	// Only the LABEL still depends on the preset, deliberately: a conversation
	// avatar changes what the model looks like, not what it's called.
	let assistantLabel = friendlyModelName(conversation.modelId);
	let presetAvatarMediaId: string | null = null;
	// Hoisted to a const before the closure because narrowing a PROPERTY doesn't
	// survive into a callback: reading `conversation.customModelId` inside
	// `timeDb` is `string | null` again, and TS2345s. Narrowing a VARIABLE does
	// survive, which is why the const works — and why `locals.user.id` below
	// needs no `!` after `requireUserPage`, whose assertion signature narrows
	// `locals` itself. (A `!` on the property would also compile and is NOT what
	// no-unnecessary-type-assertion flags — verified — since it genuinely changes
	// the type. The const is preferred here only for reading without one.)
	const presetId = conversation.customModelId;
	if (presetId) {
		const cm = timeDb(locals, () => getCustomModelForUser(presetId, locals.user.id));
		if (cm) {
			assistantLabel = cm.name;
			presetAvatarMediaId = cm.avatarMediaId;
		}
	}
	const assistantAvatarMediaId = conversation.avatarMediaId ?? presetAvatarMediaId;

	// Multi-model fan-out recovery: a conversation with an unresolved fan-out
	// carries an explicit marker (fanout_parent_message_id, set by .../prepare,
	// cleared on pick/dismiss). When it points at the current active leaf, the
	// page rebuilds the compare grid from the persisted branches + the count
	// still generating — so a reload mid-fan-out (iOS suspended the PWA) shows
	// the completed images plus "generating" placeholders, and the poll fills
	// the rest in as they land. The explicit marker means a retry/truncate
	// parked on a user message can't masquerade as a fan-out.
	const fanout = timeDb(locals, () =>
		getFanoutRecoveryState(conversation.id, locals.user.id, conversation.activeLeafMessageId),
	);

	// The conversation's open canvases (if any), so the side-by-side pane
	// rehydrates on load / after a reload. Empty when the conversation has none.
	// The live pane is driven by canvas_version stream events during a turn; this
	// is the durable seed, in stable creation order.
	const canvases = timeDb(locals, () => listActiveCanvases(params.id, locals.user.id));

	// Every model id this conversation refers to, and the entries for those that
	// resolve — carried on the page's payload rather than looked up in the layout's
	// `models`, which is trimmed to first-paint entries (see the (app) layout).
	//
	// Not the header, despite the obvious guess — it deliberately carries no model
	// name at all (see ChatHeader's own comment: one name would be misleading in a
	// multi-model thread). `assistantLabel`, resolved from `friendlyModelName`
	// above, feeds the assistant bubbles and the in-flight bubble instead, and is
	// independent of the catalogue.
	//
	// It is the composer's picker trigger (which falls back to the alarming "Choose
	// a model…" when it can't resolve its own value), the context-window readout,
	// the submit gate, and anything rendering a per-MESSAGE id: `assistantIdentityForMessage` for a turn answered
	// by something other than the conversation default, and the recovered fan-out
	// columns, whose header labels are baked at rebuild time inside an `untrack` and
	// so never re-render if the entry shows up later. Resolving those on the client
	// would leave both showing raw `endpoint::owner/model` ids until something else
	// happened to load the catalogue — permanently, for the columns.
	//
	// Cheap and bounded: `listAllModels` is an in-memory stale-while-revalidate
	// cache, the ids come from rows already loaded above, and a conversation refers
	// to a handful of distinct models (one, until you switch mid-thread or fan out).
	// That is the trade — a few hundred bytes per conversation against the catalogue
	// itself, which stays off the payload entirely.
	const modelResults = await listAllModelsWithErrors();
	const allModels = modelResults.flatMap((r) => r.models);
	const referencedModelIds = [
		...new Set(
			[
				conversation.modelId,
				...conversation.messages.map((m) => m.modelUsed),
				...fanout.siblings.map((m) => m.modelUsed),
				...fanout.pendingModelIds,
			].filter((id): id is string => !!id),
		),
	];
	const referencedSet = new Set(referencedModelIds);
	const referencedModels = allModels.filter((m) => referencedSet.has(m.id));
	// Which of those ids the client may treat as ANSWERED.
	//
	// `listAllModelsWithErrors` degrades a cold, unreachable endpoint to zero
	// models, so an id missing from `referencedModels` means either "not
	// configured" or "its endpoint is down right now" — and the client caches the
	// first reading permanently. Ids belonging to a failed endpoint are therefore
	// withheld from the authoritative list: the client leaves them 'unsure' and can
	// ask again, instead of disabling Send on a conversation whose model is fine.
	//
	// This is why the load reads `listAllModelsWithErrors` rather than the flat
	// `listAllModels`, which discards the error and would make an outage
	// indistinguishable from a deconfigured model.
	const failedEndpoints = new Set(modelResults.filter((r) => r.error).map((r) => r.endpointId));
	const answeredModelIds = failedEndpoints.size
		? referencedModelIds.filter((id) => {
				const endpointId = parseModelId(id)?.endpointId;
				// An unparseable id (an OWUI import's bare model name) belongs to no
				// endpoint, so no outage can explain its absence — it stays answered,
				// which is what keeps the submit gate firing for exactly that case.
				return endpointId === undefined || !failedEndpoints.has(endpointId);
			})
		: referencedModelIds;
	const hasImageModel = allModels.some((m) => m.kind === 'image');
	return {
		conversation,
		referencedModels,
		answeredModelIds,
		hasImageModel,
		assistantLabel,
		assistantAvatarMediaId,
		inFlightSince,
		avatarDrawSince,
		fanout,
		canvases,
	};
};
