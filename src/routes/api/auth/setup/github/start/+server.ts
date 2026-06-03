/**
 * POST /api/auth/setup/github/start — kick off the GitHub OAuth round-
 * trip for the first-run wizard. Validates the setup gate (count must
 * still be zero, token must match if SETUP_TOKEN is set), captures the
 * operator-supplied display name + email in a signed carry cookie, and
 * redirects to GitHub. The callback reads the carry cookie back, fetches
 * the profile, and atomically creates the user + the GitHub binding.
 *
 * Method is POST so the form submit can include the form fields; the
 * existing /api/auth/github/login GET endpoint stays for the login path
 * where there's nothing to carry.
 */
import { error, redirect } from '@sveltejs/kit';
import { generateState } from 'arctic';
import { getGithubClient, STATE_COOKIE, STATE_TTL_SECONDS } from '$lib/server/auth/github';
import { SETUP_GITHUB_CARRY_COOKIE, setupGate } from '$lib/server/auth/setup';
import { sign } from '$lib/server/auth/signed-cookies';
import { githubLoginEnabled } from '$lib/server/env';
import type { RequestHandler } from './$types';

const CARRY_TTL_MS = STATE_TTL_SECONDS * 1000;

export const POST: RequestHandler = async ({ request, cookies, url }) => {
	if (!githubLoginEnabled()) throw error(403, 'GitHub login is disabled');
	const verdict = setupGate(url);
	if (verdict !== 'allowed') throw error(403, 'Setup is not currently allowed');

	const form = await request.formData();
	const displayName = String(form.get('displayName') ?? '').trim();
	const email = String(form.get('email') ?? '').trim();
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

	// Carry the operator's typed display name / email through GitHub's
	// round-trip. Signed so the callback can trust the values without a
	// server-side stash; expires alongside the state cookie.
	const carry = sign({ displayName, email: email || null }, CARRY_TTL_MS);
	cookies.set(SETUP_GITHUB_CARRY_COOKIE, carry, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure: process.env.NODE_ENV === 'production',
		maxAge: STATE_TTL_SECONDS,
	});

	throw redirect(302, oauthUrl.toString());
};
