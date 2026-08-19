import { redirect } from '@sveltejs/kit';
import { CONVERSATION_MISSING_NOTICE } from '$lib/notices';
import { requireUserPage } from '$lib/server/auth/guard';
import { listActiveCanvases } from '$lib/server/db/queries/artifacts';
import { getConversationDetail } from '$lib/server/db/queries/conversations';
import { getCustomModelForUser } from '$lib/server/db/queries/custom-models';
import { friendlyModelName } from '$lib/server/endpoints/friendly-name';
import { getFanoutRecoveryState } from '$lib/server/messages/fanout-recovery';
import { getInFlightSince } from '$lib/server/streaming/in-flight';
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
	const conversation = getConversationDetail(params.id, locals.user.id);
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

	// Friendly identity for the assistant in message bubbles. Custom models
	// win because the user named them; otherwise we strip the verbose
	// "endpoint::owner/model" prefix down to just the recognizable slug.
	//
	// The avatar can only come from a preset — there's no per-base-model
	// avatar — so a plain base-model conversation carries a null and renders
	// exactly as it did before. It's a bare media id, not an expanded row: the
	// client turns it into a `/api/media/:id/thumbnail` URL, and this payload
	// is on the critical path for the whole conversation.
	let assistantLabel = friendlyModelName(conversation.modelId);
	let assistantAvatarMediaId: string | null = null;
	if (conversation.customModelId) {
		const cm = getCustomModelForUser(conversation.customModelId, locals.user.id);
		if (cm) {
			assistantLabel = cm.name;
			assistantAvatarMediaId = cm.avatarMediaId;
		}
	}

	// Multi-model fan-out recovery: a conversation with an unresolved fan-out
	// carries an explicit marker (fanout_parent_message_id, set by .../prepare,
	// cleared on pick/dismiss). When it points at the current active leaf, the
	// page rebuilds the compare grid from the persisted branches + the count
	// still generating — so a reload mid-fan-out (iOS suspended the PWA) shows
	// the completed images plus "generating" placeholders, and the poll fills
	// the rest in as they land. The explicit marker means a retry/truncate
	// parked on a user message can't masquerade as a fan-out.
	const fanout = getFanoutRecoveryState(
		conversation.id,
		locals.user.id,
		conversation.activeLeafMessageId,
	);

	// The conversation's open canvases (if any), so the side-by-side pane
	// rehydrates on load / after a reload. Empty when the conversation has none.
	// The live pane is driven by canvas_version stream events during a turn; this
	// is the durable seed, in stable creation order.
	const canvases = listActiveCanvases(params.id, locals.user.id);

	return { conversation, assistantLabel, assistantAvatarMediaId, inFlightSince, fanout, canvases };
};
