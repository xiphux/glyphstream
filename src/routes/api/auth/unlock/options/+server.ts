/**
 * POST /api/auth/unlock/options — start an app-lock passkey ceremony, either
 * to unlock a locked session or to prove a passkey works before turning app
 * lock on (`PUT /api/auth/app-lock`). Offers ONLY this account's credentials;
 * see `generateAuthenticationOptionsForUser`.
 */
import { error } from '@sveltejs/kit';
import {
	generateAuthenticationOptionsForUser,
	setUnlockChallengeCookie,
} from '#lib/server/auth/passkey.js';
import { listCredentialsForUser } from '#lib/server/db/queries/passkey.js';
import { passkeyLoginEnabled } from '#lib/server/env.js';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (!passkeyLoginEnabled()) error(403, 'Passkey login is disabled');
	// A locked session has no `user`, but the lock state knows whose it is.
	const userId = locals.user?.id ?? locals.appLock?.userId;
	if (!userId) error(401, 'Authentication required');
	const credentials = listCredentialsForUser(userId);
	if (credentials.length === 0) error(409, 'This account has no passkeys');
	const options = await generateAuthenticationOptionsForUser(credentials);
	setUnlockChallengeCookie(cookies, options.challenge);
	return Response.json(options);
};
