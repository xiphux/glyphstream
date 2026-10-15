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
import { error } from '@sveltejs/kit';
import {
	generateRegistrationOptionsForProspectiveUser,
	setRegistrationChallengeCookie,
} from '#lib/server/auth/passkey.js';
import { JOIN_PASSKEY_CARRY_COOKIE } from '#lib/server/auth/join.js';
import { sign, setCarryCookie } from '#lib/server/auth/signed-cookies.js';
import { parseIdentityInput } from '#lib/server/auth/identity-input.js';
import { parseJsonBody } from '#lib/server/http.js';
import { findValidInvite } from '#lib/server/db/queries/invites.js';
import { passkeyLoginEnabled } from '#lib/server/env.js';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = 5 * 60 * 1000; // 5 min — matches the challenge cookie

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!passkeyLoginEnabled()) error(403, 'Passkey login is disabled');

	const body = await parseJsonBody<{
		displayName?: unknown;
		email?: unknown;
		inviteToken?: unknown;
	}>(request);
	const inviteToken = typeof body.inviteToken === 'string' ? body.inviteToken : '';
	if (!findValidInvite(inviteToken)) {
		error(403, 'This invite link is invalid or has expired');
	}

	const { displayName, email } = parseIdentityInput(body);

	const { userId, options } = await generateRegistrationOptionsForProspectiveUser({
		displayName,
		email,
	});

	setRegistrationChallengeCookie(cookies, options.challenge);
	setCarryCookie(
		cookies,
		JOIN_PASSKEY_CARRY_COOKIE,
		sign({ userId, displayName, email, inviteToken }, CARRY_TTL_MS),
		CARRY_TTL_MS / 1000,
	);

	return Response.json(options);
};
