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
import { sign } from '$lib/server/auth/signed-cookies';
import { findValidInvite } from '$lib/server/db/queries/invites';
import { generateId } from '$lib/server/util/id';
import { passkeyLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = 5 * 60 * 1000; // 5 min — matches the challenge cookie

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!passkeyLoginEnabled()) throw error(403, 'Passkey login is disabled');

	let body: { displayName?: unknown; email?: unknown; inviteToken?: unknown };
	try {
		body = (await request.json()) as typeof body;
	} catch {
		throw error(400, 'Malformed JSON body');
	}
	const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : '';
	if (!findValidInvite(inviteToken)) {
		throw error(403, 'This invite link is invalid or has expired');
	}

	const displayName = typeof body.displayName === 'string' ? body.displayName.trim() : '';
	const email = typeof body.email === 'string' ? body.email.trim() : '';
	if (displayName.length === 0) throw error(400, 'Display name is required');
	if (displayName.length > 60) throw error(400, 'Display name too long');
	if (email.length > 120) throw error(400, 'Email too long');

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
	cookies.set(
		JOIN_PASSKEY_CARRY_COOKIE,
		sign({ userId, displayName, email: email || null, inviteToken }, CARRY_TTL_MS),
		{
			path: '/',
			httpOnly: true,
			sameSite: 'lax',
			secure: process.env.NODE_ENV === 'production',
			maxAge: 300,
		},
	);

	return json(options);
};
