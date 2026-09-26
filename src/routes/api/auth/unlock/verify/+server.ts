/**
 * POST /api/auth/unlock/verify `{ response }` — finish unlocking an app-locked
 * session: verify the assertion is from one of THIS account's passkeys, then
 * open a fresh window on the session. See server/auth/app-lock.ts.
 */
import { error, json } from '@sveltejs/kit';
import { verifyUnlockAssertion } from '$lib/server/auth/app-lock';
import { setSessionUnlockedUntil } from '$lib/server/auth/session';
import { passkeyLoginEnabled } from '$lib/server/env';
import { parseJsonBody } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, cookies, request }) => {
	if (!passkeyLoginEnabled()) error(403, 'Passkey login is disabled');
	const lock = locals.appLock;
	if (!lock) error(401, 'Authentication required');
	const body = await parseJsonBody<{ response?: unknown }>(request);
	await verifyUnlockAssertion(cookies, body.response, lock.userId);
	setSessionUnlockedUntil(lock.sessionId, Date.now() + lock.timeoutMs);
	return json({ ok: true });
};
