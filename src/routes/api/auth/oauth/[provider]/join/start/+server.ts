/**
 * POST /api/auth/oauth/:provider/join/start — kick off the OAuth round-trip
 * for invite redemption. The multi-user twin of the setup/start endpoint:
 * instead of the setup gate it validates the invite token, and it carries
 * the token (alongside the typed display name + email) through the
 * provider's round-trip in a signed cookie. The shared callback detects
 * JOIN_OAUTH_CARRY_COOKIE and creates the invited user.
 *
 * Returns JSON `{ url }` rather than a 302 for the same CSP reason as the
 * setup endpoint (form-action 'self' would reject a POST ending at the
 * external IdP; a client-driven navigation isn't policed the same way).
 */
import { error, json } from '@sveltejs/kit';
import { getEnabledProvider } from '$lib/server/auth/oauth/registry';
import {
	CODE_VERIFIER_COOKIE,
	STATE_COOKIE,
	STATE_TTL_SECONDS,
} from '$lib/server/auth/oauth/cookies';
import { JOIN_OAUTH_CARRY_COOKIE } from '$lib/server/auth/join';
import { sign, setCarryCookie } from '$lib/server/auth/signed-cookies';
import { parseIdentityInput } from '$lib/server/auth/identity-input';
import { parseJsonBody } from '$lib/server/http';
import { findValidInvite } from '$lib/server/db/queries/invites';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = STATE_TTL_SECONDS * 1000;

export const POST: RequestHandler = async ({ request, cookies, params }) => {
	const provider = getEnabledProvider(params.provider);
	if (!provider) throw error(404, 'Unknown or disabled provider');

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

	const { url: oauthUrl, state, codeVerifier } = await provider.createAuthorizationURL();

	setCarryCookie(cookies, STATE_COOKIE, state, STATE_TTL_SECONDS);
	if (codeVerifier) setCarryCookie(cookies, CODE_VERIFIER_COOKIE, codeVerifier, STATE_TTL_SECONDS);

	// Carry the invite token + typed identity through the provider's round-
	// trip. Signed (HMAC, AUTH_SECRET) + TTL'd so the callback can trust it
	// without a server-side stash; the callback re-validates the invite freshly.
	const carry = sign({ displayName, email, inviteToken }, CARRY_TTL_MS);
	setCarryCookie(cookies, JOIN_OAUTH_CARRY_COOKIE, carry, STATE_TTL_SECONDS);

	return json({ url: oauthUrl.toString() });
};
