/**
 * POST /api/auth/setup/passkey/verify — finish the first-run passkey
 * registration. Re-validates the setup gate, verifies the registration
 * response against the challenge cookie, then atomically creates the
 * user row (with the prospective id from the carry cookie — which the
 * authenticator already recorded as the userHandle) and the credential
 * row. Signs the operator in.
 */
import { error, json } from '@sveltejs/kit';
import { verifyRegistrationCeremony } from '$lib/server/auth/passkey';
import { SETUP_PASSKEY_CARRY_COOKIE, setupGate } from '$lib/server/auth/setup';
import { verify } from '$lib/server/auth/signed-cookies';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import { insertCredential } from '$lib/server/db/queries/passkey';
import { createInitialUser } from '$lib/server/db/queries/users';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

interface CarryPayload {
	userId: string;
	displayName: string;
	email: string | null;
}

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');
	// Re-check gate to close the parallel-tab race where two browsers
	// both run /setup and the second tries to land here after the first
	// already created the user.
	const verdict = setupGate(url);
	if (verdict === 'closed') throw error(409, 'Setup is already complete');
	if (verdict !== 'allowed') throw error(403, 'Setup is not currently allowed');

	// Read the carry state before the ceremony (which throws on a missing
	// challenge first); both short-lived cookies are cleared either way.
	const carrySigned = cookies.get(SETUP_PASSKEY_CARRY_COOKIE);
	cookies.delete(SETUP_PASSKEY_CARRY_COOKIE, { path: '/' });
	const carry = verify<CarryPayload>(carrySigned);
	if (!carry) throw error(400, 'Missing or expired setup state');

	const { credential, backedUp, deviceType, transports } = await verifyRegistrationCeremony(
		cookies,
		request,
	);

	const userId = createInitialUser({
		id: carry.userId,
		displayName: carry.displayName,
		email: carry.email,
	});
	insertCredential({
		id: credential.id,
		userId,
		publicKey: credential.publicKey,
		counter: credential.counter,
		transports,
		backedUp,
		deviceType,
		name: null,
	});

	const { token, expiresAt } = createSession(userId);
	setSessionCookie(cookies, token, expiresAt);

	return json({ ok: true });
};
