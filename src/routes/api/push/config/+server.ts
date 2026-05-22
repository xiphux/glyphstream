/**
 * GET /api/push/config — return the VAPID public key the client needs
 * to call `pushManager.subscribe({ applicationServerKey })`, plus a
 * boolean indicating whether push is configured at all.
 *
 * Returning a small dynamic config (rather than baking the key into
 * the client bundle via $env/static/public) keeps all VAPID setup in
 * config.toml and lets the operator rotate the keypair with just a
 * config edit + restart — no rebuild required.
 */

import { json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import { getVapidPublicKey } from '$lib/server/push/web-push';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	// Auth-gated: the public key isn't a secret per se, but there's no
	// reason to expose any internal config to anonymous callers.
	requireUser(locals);
	const vapidPublicKey = getVapidPublicKey();
	return json({
		enabled: vapidPublicKey !== null,
		vapidPublicKey
	});
};
