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
import { requireUser } from '$lib/server/auth/guard';
import { parseJsonBody } from '$lib/server/http';
import {
	deletePushSubscriptionByEndpoint,
	upsertPushSubscription,
} from '$lib/server/db/queries/push-subscriptions';
import { getVapidPublicKey } from '$lib/server/push/web-push';
import {
	assertHostnameRoutable,
	assertHttpScheme,
	UrlPolicyError,
} from '$lib/server/tools/url-policy-base';
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

/**
 * Validate that a push endpoint URL is safe to store and later POST to.
 *
 * The endpoint is the URL the browser hands back from
 * `pushManager.subscribe()` — normally something like
 * `https://fcm.googleapis.com/...` or `https://updates.push.services.mozilla.com/...`.
 * Nothing on this code path forces it to be one of those, though: an
 * authenticated client can submit any string, and when notifications fire
 * later, the web-push library will dutifully POST the (potentially
 * sensitive) notification payload to it.
 *
 * Run the same scheme + private-IP check our `fetch_url` tool uses so a
 * malicious or compromised client can't aim the push channel at
 * 169.254.169.254 (AWS metadata), an internal admin endpoint, or a
 * `file:`/`gopher:` URL. Multi-user deployments (v2) inherit the same
 * protection without further work.
 */
async function validatePushEndpoint(raw: string): Promise<void> {
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw error(400, 'Push endpoint is not a valid URL');
	}
	try {
		assertHttpScheme(url);
		await assertHostnameRoutable(url.hostname);
	} catch (e) {
		if (e instanceof UrlPolicyError) throw error(400, e.message);
		throw e;
	}
}

export const POST: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);
	// Soft 503 when the operator hasn't configured VAPID keys: the
	// subscription would be unusable since we couldn't sign push payloads
	// to it. Better to refuse the subscription than to silently store a
	// row we'd never use.
	if (getVapidPublicKey() === null) {
		throw error(503, 'Push notifications are not configured on this server');
	}

	const body = await parseJsonBody<SubscribeBody>(request);

	const endpoint = requireString(body.endpoint, 'endpoint');
	await validatePushEndpoint(endpoint);
	const keys = body.keys ?? {};
	const p256dh = requireString(keys.p256dh, 'keys.p256dh');
	const auth = requireString(keys.auth, 'keys.auth');
	const userAgent = typeof body.userAgent === 'string' ? body.userAgent : null;

	const row = upsertPushSubscription({
		userId: locals.user.id,
		endpoint,
		p256dh,
		auth,
		userAgent,
	});
	return json({ id: row.id, endpoint: row.endpoint }, { status: 201 });
};

export const DELETE: RequestHandler = async ({ locals, request }) => {
	requireUser(locals);

	const body = await parseJsonBody<{ endpoint?: unknown }>(request);
	const endpoint = requireString(body.endpoint, 'endpoint');

	const removed = deletePushSubscriptionByEndpoint(endpoint, locals.user.id);
	if (!removed) throw error(404, 'No matching subscription');
	return json({ ok: true });
};
