/**
 * POST /api/push/subscribe    — register or refresh a push subscription
 *                                for the caller's account.
 * DELETE /api/push/subscribe  — remove a specific endpoint from the
 *                                caller's account.
 *
 * Both methods take the same `endpoint` identity: the URL the push
 * service hands to the browser at `pushManager.subscribe()` time.
 * POST is idempotent — the same endpoint posted twice is one row.
 * DELETE is scoped: it only removes the row if the endpoint is owned
 * by the calling user, so one user can't unsubscribe another's device.
 */

import { error, json } from '@sveltejs/kit';
import {
	deletePushSubscriptionByEndpoint,
	upsertPushSubscription
} from '$lib/server/db/queries/push-subscriptions';
import { getVapidPublicKey } from '$lib/server/push/web-push';
import type { RequestHandler } from './$types';

interface SubscribeBody {
	endpoint?: unknown;
	keys?: { p256dh?: unknown; auth?: unknown };
	userAgent?: unknown;
}

function requireString(v: unknown, field: string): string {
	if (typeof v !== 'string' || v.length === 0) {
		throw error(400, `Field "${field}" must be a non-empty string`);
	}
	return v;
}

export const POST: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Authentication required');
	// Soft 503 when the operator hasn't configured VAPID keys: the
	// subscription would be unusable since we couldn't sign push payloads
	// to it. Better to refuse the subscription than to silently store a
	// row we'd never use.
	if (getVapidPublicKey() === null) {
		throw error(503, 'Push notifications are not configured on this server');
	}

	let body: SubscribeBody;
	try {
		body = (await request.json()) as SubscribeBody;
	} catch {
		throw error(400, 'Request body must be JSON');
	}

	const endpoint = requireString(body.endpoint, 'endpoint');
	const keys = body.keys ?? {};
	const p256dh = requireString(keys.p256dh, 'keys.p256dh');
	const auth = requireString(keys.auth, 'keys.auth');
	const userAgent = typeof body.userAgent === 'string' ? body.userAgent : null;

	const row = upsertPushSubscription({
		userId: locals.user.id,
		endpoint,
		p256dh,
		auth,
		userAgent
	});
	return json({ id: row.id, endpoint: row.endpoint }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	if (!locals.user) throw error(401, 'Authentication required');

	let body: { endpoint?: unknown };
	try {
		body = (await request.json()) as { endpoint?: unknown };
	} catch {
		throw error(400, 'Request body must be JSON');
	}
	const endpoint = requireString(body.endpoint, 'endpoint');

	const removed = deletePushSubscriptionByEndpoint(endpoint, locals.user.id);
	if (!removed) throw error(404, 'No matching subscription');
	return json({ ok: true });
};
