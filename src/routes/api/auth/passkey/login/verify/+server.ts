/**
 * POST /api/auth/passkey/login/verify — finish a passkey login. Resolves
 * the credential by its id, verifies the signed assertion, refuses if
 * the bound user is disabled, updates the counter + last_used_at, and
 * creates a session.
 *
 * Counter-clone guard: WebAuthn's `newCounter` should monotonically
 * increase for hardware-counted authenticators. If `stored > 0 && new
 * <= stored`, the credential may have been cloned and we 401 without
 * updating. The `stored > 0` half is intentional — Apple iCloud
 * Keychain (and some other platform authenticators) always returns 0,
 * so a naive `new <= stored` check would lock out every Mac and iPhone
 * user on their second login.
 *
 * userHandle cross-check: the authenticator returns the `userID` we
 * stashed during registration (UTF-8 bytes of users.id). Decode and
 * assert it equals the credential row's user_id. Belt-and-suspenders
 * against DB corruption / environment mixing.
 */
import { error, json } from '@sveltejs/kit';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import {
	clearLoginChallengeCookie,
	decodeUserHandle,
	readLoginChallengeCookie,
	verifyAuthentication,
} from '$lib/server/auth/passkey';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import { bumpUserLastLogin } from '$lib/server/db/queries/users';
import {
	findCredentialById,
	findUserForCredential,
	updateCredentialCounterAndLastUsed,
} from '$lib/server/db/queries/passkey';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ cookies, request }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');

	const challenge = readLoginChallengeCookie(cookies);
	clearLoginChallengeCookie(cookies);
	if (!challenge) throw error(400, 'Missing or expired login challenge');

	let body: { response?: AuthenticationResponseJSON };
	try {
		body = (await request.json()) as { response?: AuthenticationResponseJSON };
	} catch {
		throw error(400, 'Malformed JSON body');
	}
	const response = body.response;
	if (!response || typeof response !== 'object' || typeof response.id !== 'string') {
		throw error(400, 'Missing authentication response');
	}

	const credential = findCredentialById(response.id);
	if (!credential) throw error(401, 'Unknown credential');

	// The authenticator echoes back the `userID` we set at registration.
	// If it disagrees with the credential row's user_id, something is
	// deeply wrong — refuse rather than guess which side to trust.
	const handleUserId = decodeUserHandle(response.response?.userHandle ?? null);
	if (handleUserId && handleUserId !== credential.userId) {
		console.warn(
			`[passkey/login] userHandle mismatch on credential ${credential.id}: ${handleUserId} vs row ${credential.userId}`,
		);
		throw error(401, 'Credential identity mismatch');
	}

	const owner = findUserForCredential(credential.id);
	if (!owner) throw error(401, 'Unknown credential');

	// Disabled-flag check mirrors the GitHub callback's behavior:
	// revocation applies uniformly across login methods. Existing
	// sessions stop resolving at the next request thanks to the
	// `disabled_at IS NULL` filter in validateSessionToken; new logins
	// are refused here.
	if (owner.disabledAt !== null) {
		console.warn(`[passkey/login] Rejecting credential ${credential.id} — bound user is disabled`);
		throw error(403, 'This account is not authorized to use this instance.');
	}

	let verification;
	try {
		verification = await verifyAuthentication(response, {
			expectedChallenge: challenge,
			credential: {
				id: credential.id,
				// `.slice()` produces a `Uint8Array<ArrayBuffer>` (the exact
				// shape SimpleWebAuthn's `Uint8Array_` aliases). Our row type
				// is plain `Uint8Array` to stay consumer-agnostic.
				publicKey: credential.publicKey.slice(),
				counter: credential.counter,
				transports: credential.transports ?? undefined,
			},
		});
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Verification failed';
		throw error(401, message);
	}
	if (!verification.verified) throw error(401, 'Passkey verification failed');

	const newCounter = verification.authenticationInfo.newCounter;
	// `> 0` on the stored side is intentional — see file header.
	if (credential.counter > 0 && newCounter <= credential.counter) {
		console.warn(
			`[passkey/login] Counter regression on credential ${credential.id}: stored=${credential.counter} new=${newCounter}. Possible clone.`,
		);
		throw error(401, 'Possible cloned credential');
	}

	const now = Date.now();
	updateCredentialCounterAndLastUsed(credential.id, newCounter, now);
	bumpUserLastLogin(owner.userId);

	const { token, expiresAt } = createSession(owner.userId);
	setSessionCookie(cookies, token, expiresAt);

	return json({ ok: true });
};
