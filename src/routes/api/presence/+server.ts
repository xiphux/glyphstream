/**
 * POST /api/presence — heartbeat: this window is (or is no longer) actively
 * viewing a conversation.
 *
 * The client beats `{ visible: true }` while a chat window is foregrounded and
 * `{ visible: false }` when it blurs, switches thread, or unloads. The server
 * uses this only to suppress a redundant push to the user's OTHER devices
 * while one is watching the thread (see `push/presence.ts`). It writes nothing
 * to the DB and does no ownership check: presence is filed under the caller's
 * own userId, so a spoofed conversationId can only affect the caller's own
 * notifications, never another user's.
 */

import { error } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import { recordPresence } from '$lib/server/push/presence';
import type { RequestHandler } from './$types';

interface PresenceBody {
	conversationId?: unknown;
	viewerId?: unknown;
	visible?: unknown;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<PresenceBody>(request);
	if (typeof body.conversationId !== 'string' || body.conversationId.length === 0) {
		throw error(400, 'Field "conversationId" must be a non-empty string');
	}
	if (typeof body.viewerId !== 'string' || body.viewerId.length === 0) {
		throw error(400, 'Field "viewerId" must be a non-empty string');
	}
	if (typeof body.visible !== 'boolean') {
		throw error(400, 'Field "visible" must be a boolean');
	}

	recordPresence(locals.user.id, body.conversationId, body.viewerId, body.visible);
	return new Response(null, { status: 204 });
};
