/**
 * POST /api/auth/join/passkey/verify — finish passkey registration for an
 * invited user. The multi-user twin of /api/auth/setup/passkey/verify:
 * re-validates the invite token (carried in the signed cookie), verifies the
 * registration response, then atomically creates the user (with the
 * prospective id the authenticator recorded as the userHandle), inserts the
 * credential, and consumes the invite — all in one transaction. Signs in.
 */
import { error, json } from '@sveltejs/kit';
import type { RegistrationResponseJSON } from '@simplewebauthn/server';
import {
	clearRegistrationChallengeCookie,
	readRegistrationChallengeCookie,
	verifyRegistration,
} from '$lib/server/auth/passkey';
import {
	JOIN_PASSKEY_CARRY_COOKIE,
	InviteConsumedError,
	finalizePasskeyJoin,
} from '$lib/server/auth/join';
import { verify } from '$lib/server/auth/signed-cookies';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import { type AuthenticatorTransport } from '$lib/server/db/queries/passkey';
import { findValidInvite } from '$lib/server/db/queries/invites';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

interface CarryPayload {
	userId: string;
	displayName: string;
	email: string | null;
	inviteToken: string;
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

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');

	const challenge = readRegistrationChallengeCookie(cookies);
	clearRegistrationChallengeCookie(cookies);
	const carrySigned = cookies.get(JOIN_PASSKEY_CARRY_COOKIE);
	cookies.delete(JOIN_PASSKEY_CARRY_COOKIE, { path: '/' });
	if (!challenge) throw error(400, 'Missing or expired challenge');
	const carry = verify<CarryPayload>(carrySigned);
	if (!carry) throw error(400, 'Missing or expired join state');

	// Re-validate the invite at consume time — it may have expired or been
	// redeemed during the registration ceremony.
	const invite = findValidInvite(carry.inviteToken);
	if (!invite) throw error(403, 'This invite link is invalid or has expired');

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

	let userId: string;
	try {
		userId = finalizePasskeyJoin({
			inviteId: invite.id,
			role: invite.role,
			invitedByUserId: invite.createdByUserId,
			userId: carry.userId,
			displayName: carry.displayName,
			email: carry.email,
			credential: {
				id: credential.id,
				publicKey: credential.publicKey,
				counter: credential.counter,
				transports,
				backedUp: credentialBackedUp,
				deviceType: credentialDeviceType,
				name: null,
			},
		});
	} catch (e) {
		// Lost the single-use race between findValidInvite and the consume.
		if (e instanceof InviteConsumedError) {
			throw error(409, 'This invite has already been used');
		}
		throw e;
	}

	const { token, expiresAt } = createSession(userId);
	setSessionCookie(cookies, token, expiresAt);

	return json({ ok: true });
};
