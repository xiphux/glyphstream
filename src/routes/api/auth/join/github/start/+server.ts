/**
 * POST /api/auth/join/github/start — kick off the GitHub OAuth round-trip
 * for invite redemption. The multi-user twin of /api/auth/setup/github/start:
 * instead of the setup gate it validates the invite token, and it carries the
 * token (alongside the typed display name + email) through GitHub's round-trip
 * in a signed cookie. The shared callback (/api/auth/github/callback) detects
 * JOIN_GITHUB_CARRY_COOKIE and creates the invited user.
 *
 * Returns JSON `{ url }` rather than a 302 for the same CSP reason as the
 * setup endpoint (form-action 'self' would reject a POST that ends at
 * github.com; a client-driven navigation isn't policed the same way).
 */
import { error, json } from '@sveltejs/kit';
import { generateState } from 'arctic';
import { getGithubClient, STATE_COOKIE, STATE_TTL_SECONDS } from '$lib/server/auth/github';
import { JOIN_GITHUB_CARRY_COOKIE } from '$lib/server/auth/join';
import { sign, setCarryCookie } from '$lib/server/auth/signed-cookies';
import { parseIdentityInput } from '$lib/server/auth/identity-input';
import { parseJsonBody } from '$lib/server/http';
import { findValidInvite } from '$lib/server/db/queries/invites';
import { githubLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = STATE_TTL_SECONDS * 1000;

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!githubLoginEnabled()) throw error(403, 'GitHub login is disabled');

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

	const state = generateState();
	const client = getGithubClient();
	const oauthUrl = client.createAuthorizationURL(state, ['read:user', 'user:email']);

	setCarryCookie(cookies, STATE_COOKIE, state, STATE_TTL_SECONDS);

	// Carry the invite token + typed identity through GitHub's round-trip.
	// Signed (HMAC, AUTH_SECRET) + TTL'd so the callback can trust it without
	// a server-side stash; the callback re-validates the invite freshly.
	const carry = sign({ displayName, email, inviteToken }, CARRY_TTL_MS);
	setCarryCookie(cookies, JOIN_GITHUB_CARRY_COOKIE, carry, STATE_TTL_SECONDS);

	return json({ url: oauthUrl.toString() });
};
