import { error, json } from '@sveltejs/kit';
import { requireFound, requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	archiveConversation,
	deleteConversation,
	getConversationDetail,
	getConversationMeta,
	renameConversation,
	RenameValidationError,
	setDisabledFeatures,
	unarchiveConversation,
} from '$lib/server/db/queries/conversations';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import { getFanoutRecoveryState } from '$lib/server/messages/fanout-recovery';
import { getInFlightSince } from '$lib/server/streaming/in-flight';
import { validateDisabledFeaturesOrThrow400 } from '$lib/server/util/validate-features';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params, url }) => {
	requireUser(locals);

	// The recovery polls (`?fanout=1`) — TWO callers, wanting different halves:
	// the fan-out controller's 4s poll reads `fanout` (+ inFlightSince) to rebuild
	// the compare grid as branches land, and the single-turn recovery poll reads
	// ONLY `inFlightSince`. Neither wants the message list, so skip
	// getConversationDetail's walkActiveBranch (+ content_html serialization)
	// entirely here; a poll over a long thread would otherwise re-fetch the whole
	// thing each tick. getConversationMeta is the light, ownership-checked fetch
	// that still carries the activeLeafMessageId getFanoutRecoveryState needs.
	//
	// Contract the single-turn caller depends on: `inFlightSince` must stay
	// accurate for a NON-fan-out conversation too. That poll terminates only when
	// it reads null, so short-circuiting this branch on "no fan-out here" would
	// wedge it forever (see startRecoveryPoll in chat-turn-controller).
	if (url.searchParams.get('fanout') === '1') {
		const meta = requireFound(
			getConversationMeta(params.id, locals.user.id),
			'Conversation not found',
		);
		return json({
			inFlightSince: getInFlightSince(params.id),
			fanout: getFanoutRecoveryState(params.id, locals.user.id, meta.activeLeafMessageId),
		});
	}

	const conv = requireFound(
		getConversationDetail(params.id, locals.user.id),
		'Conversation not found',
	);
	// `inFlightSince` lets the chat page's single-send recovery poll detect —
	// without the heavyweight page reload — when a generation it's tracking has
	// finished (it needs the message list to see the assistant row land).
	const inFlightSince = getInFlightSince(params.id);
	const fanout = getFanoutRecoveryState(params.id, locals.user.id, conv.activeLeafMessageId);
	return json({ conversation: conv, inFlightSince, fanout });
};

/**
 * Accepts one of three mutations per request:
 *   - `{ archived: boolean }` — archive/unarchive
 *   - `{ title: string }` — rename (sets title_source='user', locking
 *      the title against future AI overwrite)
 *   - `{ disabledFeatures: string[] }` — per-conversation feature opt-outs
 *      (see FEATURE_CATEGORIES in $lib/types/api)
 *
 * Discriminated body: exactly one of the three fields must be present.
 * Combining them in one request is rejected to keep the semantics
 * single-purpose — a client that wants to do multiple should send
 * multiple requests.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{
		archived?: unknown;
		title?: unknown;
		disabledFeatures?: unknown;
	}>(request);

	const hasArchived = body.archived !== undefined;
	const hasTitle = body.title !== undefined;
	const hasDisabledFeatures = body.disabledFeatures !== undefined;
	const presentCount = [hasArchived, hasTitle, hasDisabledFeatures].filter(Boolean).length;
	if (presentCount !== 1) {
		error(
			400,
			'Body must be exactly one of { archived: boolean }, { title: string }, or { disabledFeatures: string[] }',
		);
	}

	if (hasArchived) {
		if (typeof body.archived !== 'boolean') {
			error(400, 'archived must be a boolean');
		}
		const ok = body.archived
			? archiveConversation(params.id, locals.user.id)
			: unarchiveConversation(params.id, locals.user.id);
		if (!ok) error(404, 'Conversation not found');
		return new Response(null, { status: 204 });
	}

	if (hasDisabledFeatures) {
		const features = validateDisabledFeaturesOrThrow400(body.disabledFeatures);
		const ok = setDisabledFeatures(params.id, locals.user.id, features);
		if (!ok) error(404, 'Conversation not found');
		return new Response(null, { status: 204 });
	}

	// Rename path
	if (typeof body.title !== 'string') {
		error(400, 'title must be a string');
	}
	try {
		const ok = renameConversation(params.id, locals.user.id, body.title);
		if (!ok) error(404, 'Conversation not found');
	} catch (e) {
		if (e instanceof RenameValidationError) {
			error(400, e.message);
		}
		throw e;
	}
	return new Response(null, { status: 204 });
};

export const DELETE: RequestHandler = async ({ locals, params, url }) => {
	requireUser(locals);
	// Query-string flag so the client can express "also purge media that
	// would orphan." DELETE-with-body is awkward to thread through
	// SvelteKit's fetch boundaries, so we use a flag here. Default false
	// (library model: media is preserved unless the user explicitly opts in).
	const deleteMedia = url.searchParams.get('deleteMedia') === 'true';
	const { ok, toUnlink } = deleteConversation(params.id, locals.user.id, {
		deleteMedia,
	});
	if (!ok) error(404, 'Conversation not found');

	// File unlinks happen *after* the DB transaction commits — doing them
	// inside the txn would let a rollback strand files deleted from disk
	// but still referenced from the DB. See unlinkMediaFiles.
	await unlinkMediaFiles(toUnlink, 'conversations.delete');

	return new Response(null, { status: 204 });
};
