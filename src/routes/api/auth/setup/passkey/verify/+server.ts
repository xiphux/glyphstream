/**
 * POST /api/auth/setup/passkey/verify — finish the first-run passkey
 * registration. Re-validates the setup gate, verifies the registration
 * response against the challenge cookie, then atomically creates the
 * user row (with the prospective id from the carry cookie — which the
 * authenticator already recorded as the userHandle) and the credential
 * row. Signs the operator in.
 */
import { error, json } from '@sveltejs/kit';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import {
	clearRegistrationChallengeCookie,
	readRegistrationChallengeCookie,
	verifyRegistration,
} from '$lib/server/auth/passkey';
import { setupGate } from '$lib/server/auth/setup';
import { verify } from '$lib/server/auth/signed-cookies';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import { type AuthenticatorTransport, insertCredential } from '$lib/server/db/queries/passkey';
import { createInitialUser } from '$lib/server/db/queries/users';
import { passkeyLoginEnabled } from '$lib/server/env';
import { SETUP_PASSKEY_CARRY_COOKIE } from '../options/+server';
import type { RequestHandler } from './$types';

interface CarryPayload {
	userId: string;
	displayName: string;
	email: string | null;
}

const VALID_TRANSPORTS: ReadonlySet<AuthenticatorTransport> = new Set([
	'usb',
	'ble',
	'nfc',
	'internal',
	'hybrid',
]);

function pickKnownTransports(raw: unknown): AuthenticatorTransport[] | null {
	if (!Array.isArray(raw) || raw.length === 0) return null;
	const out: AuthenticatorTransport[] = [];
	for (const t of raw) {
		if (typeof t === 'string' && VALID_TRANSPORTS.has(t as AuthenticatorTransport)) {
			out.push(t as AuthenticatorTransport);
		}
	}
	return out.length > 0 ? out : null;
}

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');
	// Re-check gate to close the parallel-tab race where two browsers
	// both run /setup and the second tries to land here after the first
	// already created the user.
	const verdict = setupGate(url);
	if (verdict === 'closed') throw error(409, 'Setup is already complete');
	if (verdict !== 'allowed') throw error(403, 'Setup is not currently allowed');

	const challenge = readRegistrationChallengeCookie(cookies);
	clearRegistrationChallengeCookie(cookies);
	const carrySigned = cookies.get(SETUP_PASSKEY_CARRY_COOKIE);
	cookies.delete(SETUP_PASSKEY_CARRY_COOKIE, { path: '/' });
	if (!challenge) throw error(400, 'Missing or expired challenge');
	const carry = verify<CarryPayload>(carrySigned);
	if (!carry) throw error(400, 'Missing or expired setup state');

	let body: { response?: RegistrationResponseJSON };
	try {
		body = (await request.json()) as { response?: RegistrationResponseJSON };
	} catch {
		throw error(400, 'Malformed JSON body');
	}
	if (!body.response || typeof body.response !== 'object') {
		throw error(400, 'Missing registration response');
	}

	let verification;
	try {
		verification = await verifyRegistration(body.response, challenge);
	} catch (e) {
		const message = e instanceof Error ? e.message : 'Verification failed';
		throw error(400, message);
	}
	if (!verification.verified || !verification.registrationInfo) {
		throw error(400, 'Passkey verification failed');
	}

	const { credential, credentialBackedUp, credentialDeviceType } = verification.registrationInfo;
	const transports = pickKnownTransports(body.response.response?.transports);

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
		backedUp: credentialBackedUp,
		deviceType: credentialDeviceType,
		name: null,
	});

	const { token, expiresAt } = createSession(userId);
	setSessionCookie(cookies, token, expiresAt);

	return json({ ok: true });
};
