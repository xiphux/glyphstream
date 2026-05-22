import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	archiveConversation,
	deleteConversation,
	getConversationDetail,
	renameConversation,
	RenameValidationError,
	unarchiveConversation
} from '$lib/server/db/queries/conversations';
import { unlinkMediaFiles } from '$lib/server/media/disk-store';
import { getInFlight } from '$lib/server/streaming/in-flight';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	requireUser(locals);
	const conv = getConversationDetail(params.id, locals.user.id);
	if (!conv) throw error(404, 'Conversation not found');
	// `inFlightSince` lets the chat page's recovery poll detect — without
	// the heavyweight page reload — when a generation it's tracking has
	// finished. DB-only otherwise, so it's cheap to poll.
	const inFlightSince = getInFlight(params.id)?.startedAt ?? null;
	return json({ conversation: conv, inFlightSince });
};

/**
 * Accepts one of two mutations per request:
 *   - `{ archived: boolean }` — archive/unarchive (original behavior)
 *   - `{ title: string }` — rename (sets title_source='user', locking
 *      the title against future AI overwrite)
 *
 * Discriminated body: exactly one of the two fields must be present.
 * Combining them in one request is rejected to keep the semantics
 * single-purpose — a client that wants to do both should send two
 * requests.
 */
export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ archived?: unknown; title?: unknown }>(request);

	const hasArchived = body.archived !== undefined;
	const hasTitle = body.title !== undefined;
	if (hasArchived === hasTitle) {
		throw error(400, 'Body must be exactly one of { archived: boolean } or { title: string }');
	}

	if (hasArchived) {
		if (typeof body.archived !== 'boolean') {
			throw error(400, 'archived must be a boolean');
		}
		const ok = body.archived
			? archiveConversation(params.id, locals.user.id)
			: unarchiveConversation(params.id, locals.user.id);
		if (!ok) throw error(404, 'Conversation not found');
		return new Response(null, { status: 204 });
	}

	// Rename path
	if (typeof body.title !== 'string') {
		throw error(400, 'title must be a string');
	}
	try {
		const ok = renameConversation(params.id, locals.user.id, body.title);
		if (!ok) throw error(404, 'Conversation not found');
	} catch (e) {
		if (e instanceof RenameValidationError) {
			throw error(400, e.message);
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
		deleteMedia
	});
	if (!ok) throw error(404, 'Conversation not found');

	// File unlinks happen *after* the DB transaction commits — doing them
	// inside the txn would let a rollback strand files deleted from disk
	// but still referenced from the DB. See unlinkMediaFiles.
	await unlinkMediaFiles(toUnlink, 'conversations.delete');

	return new Response(null, { status: 204 });
};
