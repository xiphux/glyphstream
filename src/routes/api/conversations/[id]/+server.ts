import { error, json } from '@sveltejs/kit';
import {
	archiveConversation,
	deleteConversation,
	getConversationDetail,
	renameConversation,
	RenameValidationError,
	unarchiveConversation
} from '$lib/server/db/queries/conversations';
import { getMediaStore } from '$lib/server/media/disk-store';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals, params }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const conv = getConversationDetail(params.id, locals.user.id);
	if (!conv) throw error(404, 'Conversation not found');
	return json({ conversation: conv });
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
	if (!locals.user) throw error(401, 'Authentication required');
	const body = (await request.json().catch(() => null)) as
		| { archived?: unknown; title?: unknown }
		| null;
	if (!body) throw error(400, 'Body must be JSON');

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
	if (!locals.user) throw error(401, 'Authentication required');
	// Query-string flag so the client can express "also purge media that
	// would orphan." DELETE-with-body is awkward to thread through
	// SvelteKit's fetch boundaries, so we use a flag here. Default false
	// (library model: media is preserved unless the user explicitly opts in).
	const deleteMedia = url.searchParams.get('deleteMedia') === 'true';
	const { ok, toUnlink } = deleteConversation(params.id, locals.user.id, {
		deleteMedia
	});
	if (!ok) throw error(404, 'Conversation not found');

	// File unlinks happen *after* the DB transaction commits. If we did
	// them inside the txn, a later rollback would leave files deleted
	// from disk but still referenced from the DB. Per-row try/catch so
	// one bad unlink doesn't strand the rest — leaked files on disk
	// without DB rows are invisible to the app and can be reconciled
	// later if it ever becomes a real cost.
	if (toUnlink.length > 0) {
		const store = getMediaStore();
		await Promise.all(
			toUnlink.map(async (m) => {
				try {
					await store.delete(m.storagePath);
				} catch (e) {
					console.warn(
						`[conversations.delete] failed to unlink media ${m.id} at ${m.storagePath}:`,
						e
					);
				}
			})
		);
	}

	return new Response(null, { status: 204 });
};
