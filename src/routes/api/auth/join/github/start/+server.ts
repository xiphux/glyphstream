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
import { sign } from '$lib/server/auth/signed-cookies';
import { findValidInvite } from '$lib/server/db/queries/invites';
import { githubLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = STATE_TTL_SECONDS * 1000;

export const POST: RequestHandler = async ({ request, cookies }) => {
	if (!githubLoginEnabled()) throw error(403, 'GitHub login is disabled');

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

	const state = generateState();
	const client = getGithubClient();
	const oauthUrl = client.createAuthorizationURL(state, ['read:user', 'user:email']);

	cookies.set(STATE_COOKIE, state, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: STATE_TTL_SECONDS,
	});

	// Carry the invite token + typed identity through GitHub's round-trip.
	// Signed (HMAC, AUTH_SECRET) + TTL'd so the callback can trust it without
	// a server-side stash; the callback re-validates the invite freshly.
	const carry = sign({ displayName, email: email || null, inviteToken }, CARRY_TTL_MS);
	cookies.set(JOIN_GITHUB_CARRY_COOKIE, carry, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: STATE_TTL_SECONDS,
	});

	return json({ url: oauthUrl.toString() });
};
