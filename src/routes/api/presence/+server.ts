/**
 * POST /api/presence — heartbeat: this window is (or is no longer) actively
 * rendering a generation for a conversation.
 *
 * The client beats `{ visible: true }` while a chat window is foregrounded AND
 * actively streaming/polling a generation it owns (its `renderingGeneration`
 * signal), and `{ visible: false }` when it stops rendering, blurs, switches
 * thread, or unloads — so a foregrounded-but-parked tab never beats `true`.
 * The server uses this only to suppress a redundant push to the user's OTHER
 * devices while one is rendering the thread in place (see `push/presence.ts`).
 * It writes nothing to the DB and does no ownership check: presence is filed
 * under the caller's own userId, so a spoofed conversationId can only affect
 * the caller's own notifications, never another user's.
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

// Both ids are short in practice (a conversation id and a UUID). Cap length so
// a malicious client can't pump megabytes of distinct keys into the in-memory
// map through this unauthenticated-by-content path (the body limit alone is
// 25 MB); real values are well under this.
const MAX_ID_LEN = 200;

function requireId(v: unknown, field: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw error(400, `Field "${field}" must be a non-empty string`);
	}
	if (v.length > MAX_ID_LEN) {
		throw error(400, `Field "${field}" is too long`);
	}
	return v;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<PresenceBody>(request);
	const conversationId = requireId(body.conversationId, 'conversationId');
	const viewerId = requireId(body.viewerId, 'viewerId');
	if (typeof body.visible !== 'boolean') {
		throw error(400, 'Field "visible" must be a boolean');
	}

	recordPresence(locals.user.id, conversationId, viewerId, body.visible);
	return new Response(null, { status: 204 });
};
