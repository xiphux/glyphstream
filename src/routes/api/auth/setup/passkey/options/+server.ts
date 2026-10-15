/**
 * POST /api/auth/setup/passkey/options — start the first-run passkey
 * registration. Validates the setup gate, generates a prospective user
 * UUID, builds registration options against that UUID (the
 * authenticator stores it as the userHandle), stashes a signed carry
 * cookie with the prospective id + the operator-supplied display name +
 * email, and returns the options to the browser.
 *
 * No DB writes happen here. The user row + credential row are inserted
 * atomically only after the verify endpoint sees a valid registration
 * response — abandoning the ceremony leaves no orphans.
 */
import { error } from '@sveltejs/kit';
import {
	generateRegistrationOptionsForProspectiveUser,
	setRegistrationChallengeCookie,
} from '#lib/server/auth/passkey.js';
import { SETUP_PASSKEY_CARRY_COOKIE, setupGate } from '#lib/server/auth/setup.js';
import { sign, setCarryCookie } from '#lib/server/auth/signed-cookies.js';
import { parseIdentityInput } from '#lib/server/auth/identity-input.js';
import { parseJsonBody } from '#lib/server/http.js';
import { passkeyLoginEnabled } from '#lib/server/env.js';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = 5 * 60 * 1000; // 5 min — matches the challenge cookie

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!passkeyLoginEnabled()) error(403, 'Passkey login is disabled');
	const verdict = setupGate(url);
	if (verdict !== 'allowed') error(403, 'Setup is not currently allowed');

	const { displayName, email } = parseIdentityInput(
		await parseJsonBody<{ displayName?: unknown; email?: unknown }>(request),
	);

	const { userId, options } = await generateRegistrationOptionsForProspectiveUser({
		displayName,
		email,
	});

	setRegistrationChallengeCookie(cookies, options.challenge);
	setCarryCookie(
		cookies,
		SETUP_PASSKEY_CARRY_COOKIE,
		sign({ userId, displayName, email }, CARRY_TTL_MS),
		CARRY_TTL_MS / 1000,
	);

	return Response.json(options);
};
