/**
 * POST /api/auth/join/passkey/options — start passkey registration for an
 * invited user. The multi-user twin of /api/auth/setup/passkey/options:
 * gated by a valid invite token instead of the setup gate. Generates a
 * prospective user UUID (the authenticator records it as the userHandle),
 * stashes a signed carry cookie with that id + the invite token + the typed
 * display name/email, and returns the options.
 *
 * No DB writes here — the user + credential rows are inserted (and the invite
 * consumed) atomically only after the verify endpoint sees a valid response.
 */
import { error, json } from '@sveltejs/kit';
import { RP_NAME, getRpId, setRegistrationChallengeCookie } from '$lib/server/auth/passkey';
import { generateRegistrationOptions } from '@simplewebauthn/server';
import { JOIN_PASSKEY_CARRY_COOKIE } from '$lib/server/auth/join';
import { sign, setCarryCookie } from '$lib/server/auth/signed-cookies';
import { parseIdentityInput } from '$lib/server/auth/identity-input';
import { parseJsonBody } from '$lib/server/http';
import { findValidInvite } from '$lib/server/db/queries/invites';
import { generateId } from '$lib/server/util/id';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = 5 * 60 * 1000; // 5 min — matches the challenge cookie

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');

	const body = await parseJsonBody<{
		displayName?: unknown;
		email?: unknown;
		inviteToken?: unknown;
	}>(request);
	const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : '';
	if (!findValidInvite(inviteToken)) {
		throw error(403, 'This invite link is invalid or has expired');
	}

	const { displayName, email } = parseIdentityInput(body);

	const userId = generateId();
	const userName = email || displayName;
	const options = await generateRegistrationOptions({
		rpName: RP_NAME,
		rpID: getRpId(),
		userName,
		userDisplayName: displayName,
		userID: new TextEncoder().encode(userId),
		attestationType: 'none',
		authenticatorSelection: {
			residentKey: 'preferred',
			userVerification: 'required',
		},
		excludeCredentials: [],
		timeout: 60_000,
	});

	setRegistrationChallengeCookie(cookies, options.challenge);
	setCarryCookie(
		cookies,
		JOIN_PASSKEY_CARRY_COOKIE,
		sign({ userId, displayName, email, inviteToken }, CARRY_TTL_MS),
		CARRY_TTL_MS / 1000,
	);

	return json(options);
};
