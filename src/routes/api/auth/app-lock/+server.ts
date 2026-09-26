/**
 * GET /api/auth/app-lock — the installed app's keep-alive and resume check.
 *   200 `{ locked: false }` while the session is usable (the session hook has
 *   already slid its window forward — this request IS the keep-alive), 423 when
 *   it has locked, 401 when there's no session at all.
 *
 * PUT /api/auth/app-lock `{ timeoutMs: number | null, response? }` — change
 *   the setting. Turning it ON needs a passkey assertion from the unlock
 *   ceremony (`/api/auth/unlock/options`): it proves a passkey for this account
 *   works on the device before anything depends on one, so the feature can't
 *   be switched on straight into a lockout. Changing the window or turning it
 *   off needs only the (unlocked) session — anyone holding that already has
 *   the access the lock guards.
 *
 * See server/auth/app-lock.ts for the design.
 */
import { error, json } from '@sveltejs/kit';
import { isAppLockTimeout } from '$lib/app-lock';
import { requireUser } from '$lib/server/auth/guard';
import {
	getAppLockTimeout,
	setAppLockTimeout,
	verifyUnlockAssertion,
} from '$lib/server/auth/app-lock';
import { setSessionUnlockedUntil } from '$lib/server/auth/session';
import { countCredentialsForUser } from '$lib/server/db/queries/passkey';
import { passkeyLoginEnabled } from '$lib/server/env';
import { parseJsonBody } from '$lib/server/http';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = ({ locals }) => {
	requireUser(locals);
	return json({ locked: false });
};

export const PUT: RequestHandler = async ({ locals, request, cookies }) => {
	requireUser(locals);
	const body = await parseJsonBody<{ timeoutMs?: unknown; response?: unknown }>(request);
	if (body.timeoutMs !== null && !isAppLockTimeout(body.timeoutMs)) {
		error(400, '`timeoutMs` must be null or one of the offered windows');
	}
	const timeoutMs = body.timeoutMs;

	if (timeoutMs !== null) {
		if (!passkeyLoginEnabled()) error(409, 'Passkeys are disabled on this instance');
		if (countCredentialsForUser(locals.user.id) === 0) {
			error(409, 'Add a passkey before turning on app lock');
		}
		if (getAppLockTimeout(locals.user.id) === null) {
			await verifyUnlockAssertion(cookies, body.response, locals.user.id);
		}
	}

	setAppLockTimeout(locals.user.id, timeoutMs);
	// Start this session's window now. Otherwise an installed app that just
	// switched the lock on would find its own session (NULL window) locked on
	// the very next request.
	if (locals.sessionId) {
		setSessionUnlockedUntil(locals.sessionId, timeoutMs === null ? null : Date.now() + timeoutMs);
	}
	return json({ timeoutMs });
};
