/**
 * POST /api/auth/passkey/register/options — start a passkey registration
 * ceremony. The caller must already be signed in (passkeys are an
 * additional login method bound to an existing user, never a way to
 * bootstrap an account).
 *
 * Stashes the SimpleWebAuthn-generated challenge in a short-lived
 * httpOnly cookie; the matching `register/verify` route reads it back
 * and clears it as a single-use nonce.
 */
import { error, json } from '@sveltejs/kit';
import { requireUser } from '$lib/server/auth/guard';
import {
	generateRegistrationOptionsForUser,
	setRegistrationChallengeCookie,
} from '$lib/server/auth/passkey';
import { listCredentialsForUser } from '$lib/server/db/queries/passkey';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ locals, cookies }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');
	requireUser(locals);
	const existing = listCredentialsForUser(locals.user.id);
	const options = await generateRegistrationOptionsForUser(locals.user, existing);
	setRegistrationChallengeCookie(cookies, options.challenge);
	return json(options);
};
