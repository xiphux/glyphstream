/**
 * POST /api/auth/setup/passkey/verify — finish the first-run passkey
 * registration. Re-validates the setup gate, verifies the registration
 * response against the challenge cookie, then atomically creates the
 * user row (with the prospective id from the carry cookie — which the
 * authenticator already recorded as the userHandle) and the credential
 * row. Signs the operator in.
 */
import { error } from '@sveltejs/kit';
import { verifyRegistrationCeremony } from '#lib/server/auth/passkey.js';
import { SETUP_PASSKEY_CARRY_COOKIE, setupGate } from '#lib/server/auth/setup.js';
import { clearAuthCookie, verify } from '#lib/server/auth/signed-cookies.js';
import { startSession } from '#lib/server/auth/session.js';
import { insertCredential } from '#lib/server/db/queries/passkey.js';
import { createInitialUser, SetupClosedError } from '#lib/server/db/queries/users.js';
import { passkeyLoginEnabled } from '#lib/server/env.js';
import type { RequestHandler } from './$types';

interface CarryPayload {
	userId: string;
	displayName: string;
	email: string | null;
}

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!passkeyLoginEnabled()) error(403, 'Passkey login is disabled');
	// Re-check gate to close the parallel-tab race where two browsers
	// both run /setup and the second tries to land here after the first
	// already created the user.
	const verdict = setupGate(url);
	if (verdict === 'closed') error(409, 'Setup is already complete');
	if (verdict !== 'allowed') error(403, 'Setup is not currently allowed');

	// Read the carry state before the ceremony (which throws on a missing
	// challenge first); both short-lived cookies are cleared either way.
	const carrySigned = cookies.get(SETUP_PASSKEY_CARRY_COOKIE);
	clearAuthCookie(cookies, SETUP_PASSKEY_CARRY_COOKIE);
	const carry = verify<CarryPayload>(carrySigned);
	if (!carry) error(400, 'Missing or expired setup state');

	const { credential, backedUp, deviceType, transports } = await verifyRegistrationCeremony(
		cookies,
		request,
	);

	// The gate ran before the ceremony's await; a parallel setup that finished
	// in between closes it. Same answer the gate would now give.
	let userId: string;
	try {
		userId = createInitialUser({
			id: carry.userId,
			displayName: carry.displayName,
			email: carry.email,
		});
	} catch (e) {
		if (e instanceof SetupClosedError) error(409, 'Setup is already complete');
		throw e;
	}
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

	startSession(cookies, userId, request.headers.get('user-agent'));

	return Response.json({ ok: true });
};
