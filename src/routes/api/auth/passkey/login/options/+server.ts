/**
 * POST /api/auth/passkey/login/options — start a passkey login
 * ceremony. Discoverable-credential / usernameless: `allowCredentials`
 * is empty, the browser shows the user a picker of resident credentials
 * for this RP ID, and the login page never asks for a username.
 *
 * Stashes the challenge in a short-lived httpOnly cookie that
 * `login/verify` reads back.
 */
import { error, json } from '@sveltejs/kit';
import {
	generateAuthenticationOptionsAny,
	setLoginChallengeCookie,
} from '$lib/server/auth/passkey';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');
	const options = await generateAuthenticationOptionsAny();
	setLoginChallengeCookie(cookies, options.challenge);
	return json(options);
};
