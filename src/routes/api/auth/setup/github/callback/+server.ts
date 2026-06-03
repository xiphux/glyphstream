/**
 * GET /api/auth/setup/github/callback — finish the first-run GitHub
 * OAuth round-trip. Re-validates the setup gate (a parallel browser
 * tab could have completed setup while this round-trip was in flight),
 * fetches the profile, atomically creates the user + the GitHub
 * binding, and signs the operator in.
 */
import { redirect } from '@sveltejs/kit';
import { OAuth2RequestError, STATE_COOKIE, fetchGithubProfile } from '$lib/server/auth/github';
import { SETUP_GITHUB_CARRY_COOKIE, setupGate } from '$lib/server/auth/setup';
import { verify } from '$lib/server/auth/signed-cookies';
import { addOAuthAccount } from '$lib/server/db/queries/oauth-accounts';
import { createInitialUser } from '$lib/server/db/queries/users';
import { createSession, setSessionCookie } from '$lib/server/auth/session';
import type { RequestHandler } from './$types';

interface CarryPayload {
	displayName: string;
	email: string | null;
}

function setupError(reason: string): never {
	throw redirect(302, `/setup?error=${encodeURIComponent(reason)}`);
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	// Re-check the gate. Closing it here is the load-bearing defense
	// against the "two tabs both running /setup" race — whoever
	// completes second sees the wizard already closed.
	const verdict = setupGate(url);
	if (verdict === 'closed') throw redirect(302, '/login');
	if (verdict !== 'allowed') setupError('setup_token_required');

	const code = url.searchParams.get('code');
	const state = url.searchParams.get('state');
	const storedState = cookies.get(STATE_COOKIE);
	const carrySigned = cookies.get(SETUP_GITHUB_CARRY_COOKIE);
	cookies.delete(STATE_COOKIE, { path: '/' });
	cookies.delete(SETUP_GITHUB_CARRY_COOKIE, { path: '/' });

	if (!code || !state || !storedState || state !== storedState) {
		setupError('invalid_oauth_state');
	}
	const carry = verify<CarryPayload>(carrySigned);
	if (!carry) setupError('invalid_oauth_state');

	let profile;
	try {
		profile = await fetchGithubProfile(code);
	} catch (e) {
		if (e instanceof OAuth2RequestError) setupError('oauth_exchange_failed');
		console.error('[setup/github/callback] GitHub profile fetch failed:', e);
		setupError('upstream_failure');
	}

	// Create user + binding. The display name + email the operator
	// typed at /setup win over GitHub's profile fields; falling back
	// to GitHub when those are empty is handled at /setup-page-load
	// time (display name is required), so by this point we have what
	// we need.
	const userId = createInitialUser({
		displayName: carry.displayName,
		email: carry.email ?? profile.email,
	});
	addOAuthAccount({
		userId,
		provider: 'github',
		externalId: String(profile.id),
		externalUsername: profile.login,
		externalEmail: profile.email,
	});

	const { token, expiresAt } = createSession(userId);
	setSessionCookie(cookies, token, expiresAt);

	throw redirect(302, '/');
};
