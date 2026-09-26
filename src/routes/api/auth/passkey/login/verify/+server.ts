/**
 * POST /api/auth/passkey/login/verify — finish a passkey login. Resolves
 * the credential by its id, refuses if the bound user is disabled,
 * verifies the signed assertion (userHandle cross-check + counter-clone
 * guard live in `verifyStoredCredentialAssertion`), and creates a session.
 */
import { error, json } from '@sveltejs/kit';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
	clearLoginChallengeCookie,
	readLoginChallengeCookie,
	verifyStoredCredentialAssertion,
} from '$lib/server/auth/passkey';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import { getAppLockTimeout, initialUnlockedUntil } from '$lib/server/auth/app-lock';
import { bumpUserLastLogin } from '$lib/server/db/queries/users';
import { findCredentialById, findUserForCredential } from '$lib/server/db/queries/passkey';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, request }) => {
	if (!passkeyLoginEnabled()) error(403, 'Passkey login is disabled');

	const challenge = readLoginChallengeCookie(cookies);
	clearLoginChallengeCookie(cookies);
	if (!challenge) error(400, 'Missing or expired login challenge');

	let body: { response?: AuthenticationResponseJSON };
	try {
		body = (await request.json()) as { response?: AuthenticationResponseJSON };
	} catch {
		error(400, 'Malformed JSON body');
	}
	const response = body.response;
	if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
		error(400, 'Missing authentication response');
	}

	const credential = findCredentialById(response.id);
	if (!credential) error(401, 'Unknown credential');

	const owner = findUserForCredential(credential.id);
	if (!owner) error(401, 'Unknown credential');

	// Disabled-flag check mirrors the GitHub callback's behavior:
	// revocation applies uniformly across login methods. Existing
	// sessions stop resolving at the next request thanks to the
	// `disabled_at IS NULL` filter in validateSessionToken; new logins
	// are refused here.
	if (owner.disabledAt !== null) {
		console.warn(`[passkey/login] Rejecting credential ${credential.id} — bound user is disabled`);
		error(403, 'This account is not authorized to use this instance.');
	}

	await verifyStoredCredentialAssertion(response, challenge, credential, 'passkey/login');
	bumpUserLastLogin(owner.userId);

	const { token, expiresAt } = createSession(
		owner.userId,
		request.headers.get('user-agent'),
		initialUnlockedUntil(getAppLockTimeout(owner.userId), 'passkey'),
	);
	setSessionCookie(cookies, token, expiresAt);

	return json({ ok: true });
};
