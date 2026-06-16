/**
 * POST /api/auth/join/passkey/verify — finish passkey registration for an
 * invited user. The multi-user twin of /api/auth/setup/passkey/verify:
 * re-validates the invite token (carried in the signed cookie), verifies the
 * registration response, then atomically creates the user (with the
 * prospective id the authenticator recorded as the userHandle), inserts the
 * credential, and consumes the invite — all in one transaction. Signs in.
 */
import { error, json } from '@sveltejs/kit';
import { verifyRegistrationCeremony } from '$lib/server/auth/passkey';
import {
	JOIN_PASSKEY_CARRY_COOKIE,
	InviteConsumedError,
	finalizePasskeyJoin,
} from '$lib/server/auth/join';
import { verify } from '$lib/server/auth/signed-cookies';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import { findValidInvite } from '$lib/server/db/queries/invites';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

interface CarryPayload {
	userId: string;
	displayName: string;
	email: string | null;
	inviteToken: string;
}

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');

	// Read the carry state before the ceremony (which throws on a missing
	// challenge first); both short-lived cookies are cleared either way.
	const carrySigned = cookies.get(JOIN_PASSKEY_CARRY_COOKIE);
	cookies.delete(JOIN_PASSKEY_CARRY_COOKIE, { path: '/' });
	const carry = verify<CarryPayload>(carrySigned);
	if (!carry) throw error(400, 'Missing or expired join state');

	// Re-validate the invite at consume time — it may have expired or been
	// redeemed during the registration ceremony.
	const invite = findValidInvite(carry.inviteToken);
	if (!invite) throw error(403, 'This invite link is invalid or has expired');

	const { credential, backedUp, deviceType, transports } = await verifyRegistrationCeremony(
		cookies,
		request,
	);

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
				backedUp,
				deviceType,
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
