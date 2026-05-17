import { error, json } from '@sveltejs/kit';
import {
	archiveConversation,
	deleteConversation,
	getConversationDetail,
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

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	const body = (await request.json().catch(() => null)) as { archived?: unknown } | null;
	if (!body || typeof body.archived !== 'boolean') {
		throw error(400, 'Body must be { archived: boolean }');
	}
	const ok = body.archived
		? archiveConversation(params.id, locals.user.id)
		: unarchiveConversation(params.id, locals.user.id);
	if (!ok) throw error(404, 'Conversation not found');
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
